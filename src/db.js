'use strict';
const mysql = require('mysql2/promise');
const config = require('./config');

const pool = mysql.createPool({ ...config.db, connectionLimit: 5 });
pool.pool.on('connection', (c) => c.query("SET time_zone = '+00:00'"));

module.exports = { pool };
