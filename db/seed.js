'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { v4: uuidv4 } = require('uuid');
const db = require('./database');

const participants = [
  { name: 'Robert Anderson',    email: 'robert.anderson@gmail.com' },
  { name: 'Patricia Miller',    email: 'patricia.miller@gmail.com' },
  { name: 'John Davis',         email: 'john.davis@gmail.com' },
  { name: 'Mary Wilson',        email: 'mary.wilson@gmail.com' },
  { name: 'James Johnson',      email: 'james.johnson@gmail.com' },
  { name: 'Barbara Moore',      email: 'barbara.moore@gmail.com' },
  { name: 'Michael Taylor',     email: 'michael.taylor@gmail.com' },
  { name: 'Linda Jackson',      email: 'linda.jackson@gmail.com' },
  { name: 'William White',      email: 'william.white@gmail.com' },
  { name: 'Susan Harris',       email: 'susan.harris@gmail.com' },
  { name: 'Richard Martin',     email: 'richard.martin@gmail.com' },
  { name: 'Dorothy Thompson',   email: 'dorothy.thompson@gmail.com' },
  { name: 'Joseph Garcia',      email: 'joseph.garcia@gmail.com' },
  { name: 'Nancy Martinez',     email: 'nancy.martinez@gmail.com' },
  { name: 'Thomas Robinson',    email: 'thomas.robinson@gmail.com' },
  { name: 'Betty Clark',        email: 'betty.clark@gmail.com' },
  { name: 'Charles Rodriguez',  email: 'charles.rodriguez@gmail.com' },
  { name: 'Sandra Lewis',       email: 'sandra.lewis@gmail.com' },
  { name: 'Christopher Lee',    email: 'christopher.lee@gmail.com' },
  { name: 'Margaret Walker',    email: 'margaret.walker@gmail.com' },
  { name: 'Daniel Hall',        email: 'daniel.hall@gmail.com' },
  { name: 'Ruth Allen',         email: 'ruth.allen@gmail.com' },
  { name: 'Matthew Young',      email: 'matthew.young@gmail.com' },
  { name: 'Sharon Hernandez',   email: 'sharon.hernandez@gmail.com' },
  { name: 'Anthony King',       email: 'anthony.king@gmail.com' },
  { name: 'Carol Wright',       email: 'carol.wright@gmail.com' },
  { name: 'Mark Lopez',         email: 'mark.lopez@gmail.com' },
  { name: 'Frances Hill',       email: 'frances.hill@gmail.com' },
  { name: 'Donald Scott',       email: 'donald.scott@gmail.com' },
  { name: 'Helen Green',        email: 'helen.green@gmail.com' },
  { name: 'Steven Adams',       email: 'steven.adams@gmail.com' },
  { name: 'Diane Baker',        email: 'diane.baker@gmail.com' },
  { name: 'Paul Nelson',        email: 'paul.nelson@gmail.com' },
  { name: 'Janet Carter',       email: 'janet.carter@gmail.com' },
  { name: 'Andrew Mitchell',    email: 'andrew.mitchell@gmail.com' },
  { name: 'Virginia Perez',     email: 'virginia.perez@gmail.com' },
  { name: 'Joshua Roberts',     email: 'joshua.roberts@gmail.com' },
  { name: 'Cheryl Turner',      email: 'cheryl.turner@gmail.com' },
  { name: 'Kenneth Phillips',   email: 'kenneth.phillips@gmail.com' },
  { name: 'Evelyn Campbell',    email: 'evelyn.campbell@gmail.com' },
  { name: 'Kevin Parker',       email: 'kevin.parker@gmail.com' },
  { name: 'Katherine Evans',    email: 'katherine.evans@gmail.com' },
  { name: 'Brian Edwards',      email: 'brian.edwards@gmail.com' },
  { name: 'Alice Collins',      email: 'alice.collins@gmail.com' },
  { name: 'George Stewart',     email: 'george.stewart@gmail.com' },
  { name: 'Dorothy Sanchez',    email: 'dorothy.sanchez@gmail.com' },
];

const insert = db.prepare(
  'INSERT OR IGNORE INTO participants (name, email, rsvp_token) VALUES (?, ?, ?)'
);

const insertMany = db.transaction((rows) => {
  for (const p of rows) {
    insert.run(p.name, p.email, uuidv4());
  }
});

insertMany(participants);

const count = db.prepare('SELECT COUNT(*) AS n FROM participants').get();
console.log(`Seed complete. Participants in DB: ${count.n}`);
