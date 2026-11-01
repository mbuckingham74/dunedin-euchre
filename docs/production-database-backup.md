# Dunedin Euchre Production SQLite Backup and Restore

This runbook covers a manual, application-specific snapshot of the live Dunedin Euchre SQLite database. Application-owned operational files belong in this repository. The whole-estate recovery contract remains in `forkstech-infra/BACKUP-RECOVERY.md`; this runbook does not add a scheduler or use the frozen legacy backup material.

## Production layout

The application opens `/app/data/euchre.db` inside container `dunedin-euchre`. The live file is on the Docker named volume `dunedin-euchre_data`, mounted at `/app/data`. The host-side snapshot directory is `/home/michael/state/dunedin-euchre/backups`, outside that volume and under the production runtime-state root.

The second copy is stored on the operator's Mac at `~/.local/share/dunedin-euchre/backups`, outside the source repository. The directory and files are restricted to the operator account with POSIX mode `700` and `600`. This copy is access-controlled; this procedure does not encrypt it or provide geographic redundancy.

## Safety boundaries

- Open the live database read-only and use `better-sqlite3`'s SQLite online backup API. SQLite reads committed WAL transactions as part of the database snapshot; do not copy the `.db`, `-wal`, or `-shm` files independently and do not checkpoint the live WAL.
- Write the online-backup destination to a unique path under container `/tmp`, then copy it to the host backup directory. Never write a snapshot into `/app/data`.
- Use a new UTC timestamped name. Refuse to reuse an existing target; never use an overwrite option.
- Run `scripts/verify-sqlite-backup.js` only against the downloaded snapshot. It opens the input read-only and creates the restored test database in a fresh OS temporary directory. It does not accept a restore destination or run application migrations.
- The runbook contains no production restore or database replacement command. A future production recovery/cutover requires a separately reviewed and approved procedure.
- No container restart, application deployment, schema migration, email, or provider configuration change is part of this workflow.
- Keep shell tracing disabled. Do not print or copy application secrets.
- Put hard timeouts around SSH, Docker, and file-transfer operations. After a timeout, stop and verify the complete client/process tree has exited before cleanup or retry. Do not start a second Docker operation while the first remains unresolved.

## 1. Read-only preflight

Run from the operator Mac. These commands inspect only the target container, mount, database file sizes, available space, and whether the proposed snapshot directory already exists. Stop if the running container, source path, or named volume differs from the values below, or if the backup directory already exists unexpectedly.

```sh
timeout --kill-after=5s 20s ssh -o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=5 -o ServerAliveCountMax=1 michael@100.120.233.4 \
  'docker inspect --format "name={{.Name}} state={{.State.Status}} mounts={{json .Mounts}}" dunedin-euchre'

timeout --kill-after=5s 20s ssh -o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=5 -o ServerAliveCountMax=1 michael@100.120.233.4 \
  'set -e; echo db_bytes; docker exec dunedin-euchre stat -c %s /app/data/euchre.db; echo wal_bytes; if docker exec dunedin-euchre stat -c %s /app/data/euchre.db-wal; then :; else echo wal_absent; fi; echo container_tmp_space; docker exec dunedin-euchre df -Pk /tmp; echo host_state_space; df -Pk /home/michael/state; if [ -e /home/michael/state/dunedin-euchre/backups ] || [ -L /home/michael/state/dunedin-euchre/backups ]; then stat -c %A /home/michael/state/dunedin-euchre/backups; else echo backup_dir=absent; fi'
```

The production snapshot directory must be on the host filesystem under `/home/michael/state`, not at `/var/lib/docker/volumes/dunedin-euchre_data/_data` or `/app/data`. Confirm enough free space for a full copy before continuing.

## 2. Create the protected production snapshot

The following operation writes only a new snapshot directory/file and a temporary file under the running container's `/tmp`. The host directory is mode `700` and the snapshot file is mode `600`. It reads `/app/data/euchre.db` read-only through the SQLite online backup API. It fails if the container is not running, its `/app/data` mount is not the expected named volume, or any target already exists.

Run from the operator Mac after explicit approval for these production writes:

```sh
set -eu
umask 077
stamp="$(date -u +%Y%m%dT%H%M%SZ)"

timeout --kill-after=10s 600s ssh -T \
  -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=10 -o ServerAliveCountMax=3 \
  michael@100.120.233.4 "sh -s '$stamp'" <<'REMOTE'
set -eu
stamp=$1
container=dunedin-euchre
backup_dir=/home/michael/state/dunedin-euchre/backups
name="dunedin-euchre-${stamp}.sqlite3"
container_tmp="/tmp/${name}"
partial="${backup_dir}/.${name}.partial"
final="${backup_dir}/${name}"

test "$(docker inspect --format '{{.State.Status}}' "$container")" = running
mounts="$(docker inspect --format '{{range .Mounts}}{{.Type}}:{{.Name}}@{{.Destination}} {{end}}' "$container")"
case "$mounts" in *'volume:dunedin-euchre_data@/app/data '*) ;; *) echo 'unexpected /app/data mount' >&2; exit 1 ;; esac
test ! -e "$backup_dir"
test ! -L "$backup_dir"
test ! -e "$container_tmp"
test ! -L "$container_tmp"
mkdir -m 700 -p "$backup_dir"
test "$(stat -c '%a' "$backup_dir")" = 700
test ! -e "$partial"
test ! -L "$partial"
test ! -e "$final"
test ! -L "$final"

cleanup() {
  docker exec "$container" rm -f "$container_tmp" >/dev/null 2>&1 || true
  rm -f -- "$partial"
}
trap cleanup EXIT

docker exec "$container" node -e '
  const Database = require("better-sqlite3");
  process.umask(0o077);
  const db = new Database("/app/data/euchre.db", { readonly: true, fileMustExist: true });
  db.backup(process.argv[1])
    .then(() => db.close())
    .catch(error => {
      db.close();
      console.error(error.message);
      process.exitCode = 1;
    });
' "$container_tmp"

docker cp "${container}:${container_tmp}" "$partial"
chmod 600 "$partial"
ln "$partial" "$final"
rm -- "$partial"
docker exec "$container" rm -f "$container_tmp"
trap - EXIT
printf 'snapshot=%s\n' "$final"
sha256sum "$final"
REMOTE
```

If SSH or Docker times out, do not rerun immediately. Verify the local timeout/SSH processes exited, then run this bounded read-only process check and confirm no snapshot Node process remains:

~~~sh
timeout --kill-after=5s 20s ssh -o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=5 -o ServerAliveCountMax=1 michael@100.120.233.4 \
  'docker top dunedin-euchre'
~~~

After confirming no writer remains, remove only that run's temporary paths; keep any completed timestamped snapshot:

~~~sh
timeout --kill-after=5s 20s ssh -o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=5 -o ServerAliveCountMax=1 michael@100.120.233.4 \
  'docker exec dunedin-euchre rm -f "/tmp/dunedin-euchre-<timestamp>.sqlite3"; rm -f -- "/home/michael/state/dunedin-euchre/backups/.dunedin-euchre-<timestamp>.sqlite3.partial"'
~~~

## 3. Copy the snapshot to the operator Mac

The local directory is outside Git and access-controlled. The `mktemp` file is mode `600`; the final name is never overwritten.

```sh
set -eu
umask 077
stamp='<the UTC timestamp printed in step 2>'
name="dunedin-euchre-${stamp}.sqlite3"
remote_file="/home/michael/state/dunedin-euchre/backups/${name}"
local_dir="$HOME/.local/share/dunedin-euchre/backups"
local_file="${local_dir}/${name}"

test ! -L "$local_dir"
mkdir -p "$local_dir"
chmod 700 "$local_dir"
test ! -e "$local_file"
partial="$(mktemp "${local_dir}/.${name}.partial.XXXXXX")"
timeout --kill-after=5s 120s scp -p \
  -o BatchMode=yes -o ConnectTimeout=10 \
  "michael@100.120.233.4:${remote_file}" "$partial"
chmod 600 "$partial"
ln "$partial" "$local_file"
rm -- "$partial"

remote_hash="$(timeout --kill-after=5s 30s ssh -o BatchMode=yes -o ConnectTimeout=8 michael@100.120.233.4 "sha256sum '${remote_file}' | cut -d ' ' -f 1")"
local_hash="$(shasum -a 256 "$local_file" | awk '{print $1}')"
test "$remote_hash" = "$local_hash"
printf 'verified_copy=%s\nsha256=%s\n' "$local_file" "$local_hash"
```

If a transfer or hash check fails, retain the production snapshot, remove only the incomplete local `.partial` file after the `scp` process has exited, and retry the transfer. Do not overwrite an existing verified local copy.

## 4. Verify and test restoration in isolation

Run from the application repository root on the operator Mac:

```sh
umask 077
node scripts/verify-sqlite-backup.js \
  "$HOME/.local/share/dunedin-euchre/backups/dunedin-euchre-<timestamp>.sqlite3"
```

The verifier runs `PRAGMA integrity_check` against both the downloaded backup and the restored temporary database. It restores through SQLite's online backup API into a unique OS temporary directory, then compares table definitions, every recorded `schema_migrations` row, and row counts for every application table. It reports each table count and removes the temporary database and its directory on exit. A successful result is `PASS`.

Do not run application startup, migration, seed, import, or write scripts against the backup or temporary restore database. They are unnecessary for this validation and could change the evidence being compared.

## 5. Cleanup and retention

- The successful production operation removes its `/tmp` snapshot and `.partial` staging file, leaving the final timestamped snapshot in the protected host directory.
- The verifier removes its temporary restored database automatically. If interrupted, remove only the exact `dunedin-euchre-restore-*` directory created for that run after confirming the verifier process has exited.
- Do not automatically prune timestamped production or Mac snapshots. No retention schedule is defined by this application-specific runbook. Keep both copies until a separately approved retention decision says they may be removed.
- Before removing any production snapshot, verify that the matching Mac copy passed hash, integrity, restore, table, migration, and row-count checks. Deleting a production snapshot is a separate production write and must receive its own explicit approval.
- Never clean up `/app/data/euchre.db`, its WAL/SHM files, the `dunedin-euchre_data` volume, or files under the application uploads volume as part of this process.
- Record a completed production backup task in `forkstech-infra/history/YYYY-MM.md` per the infrastructure README. Derive its timestamp from the corresponding Git commit's committer timestamp converted to `America/Los_Angeles`; record the result without including database contents or secrets.

## 6. Recovery boundary

This procedure validates a usable snapshot in isolation. It does not replace the running database or change the application's configured database path. Any recovery that would restore or switch production state needs a separate, reviewed recovery plan, a maintenance/cutover window, and explicit approval before production writes.
