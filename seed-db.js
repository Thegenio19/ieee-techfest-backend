'use strict';

const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

// Connect to your existing database
const dbPath = path.join(__dirname, 'data', 'techfest.db');
const db = new Database(dbPath);

console.log('🌱 Seeding database for Session 4 testing...');

// The test credentials
const STUDENT_EMAIL = 'student@example.com';
const VOLUNTEER_EMAIL = 'volunteer@example.com';
const PASSWORD_PLAIN = 'password123';

// Hash the password exactly like your auth service does
const passHash = bcrypt.hashSync(PASSWORD_PLAIN, 10);

try {
  // 1. Clean slate: Delete these test users if they already exist from a previous run
  db.prepare(`DELETE FROM users WHERE email IN (?, ?)`).run(STUDENT_EMAIL, VOLUNTEER_EMAIL);

  // 2. Generate UUIDs
  const studentId = uuidv4();
  const volunteerId = uuidv4();

  // 3. Insert the Student and Volunteer
  const insertUser = db.prepare(`
    INSERT INTO users (id, name, email, password, role) 
    VALUES (?, ?, ?, ?, ?)
  `);
  
  insertUser.run(studentId, 'Test Student', STUDENT_EMAIL, passHash, 'student');
  insertUser.run(volunteerId, 'Test Volunteer', VOLUNTEER_EMAIL, passHash, 'volunteer');
  console.log(`✅ Created student: ${STUDENT_EMAIL}`);
  console.log(`✅ Created volunteer: ${VOLUNTEER_EMAIL}`);

  // 4. Create the 'pending' registration for the student
  const regId = uuidv4();
  db.prepare(`
    INSERT INTO registrations (id, user_id, status) 
    VALUES (?, ?, 'pending')
  `).run(regId, studentId);
  console.log(`✅ Created pending registration for student. Registration ID: ${regId}`);

  console.log('\n🎉 Database is ready! You can now run the test script.');

} catch (error) {
  console.error('❌ Error seeding database:', error.message);
} finally {
  db.close();
}