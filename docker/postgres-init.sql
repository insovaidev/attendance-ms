-- Runs once, the first time the Postgres volume is created.
-- One database per service: a service can only reach its own.
CREATE DATABASE auth_db;
CREATE DATABASE shift_db;
CREATE DATABASE attendance_db;
CREATE DATABASE notification_db;
