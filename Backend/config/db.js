// config/db.js — MongoDB connection with retry logic
const mongoose = require('mongoose');
const logger   = require('../utils/logger');

const connectDB = async () => {
  const options = {
    useNewUrlParser    : true,
    useUnifiedTopology : true,
    maxPoolSize        : 10,
    serverSelectionTimeoutMS : 5000,
    socketTimeoutMS    : 45000,
  };

  const connect = async () => {
    try {
      const conn = await mongoose.connect(process.env.MONGO_URI, options);
      logger.info(`MongoDB connected → ${conn.connection.host}`);
    } catch (err) {
      logger.error(`MongoDB connection error: ${err.message}`);
      logger.info('Retrying in 5 seconds…');
      setTimeout(connect, 5000);
    }
  };

  await connect();

  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected — attempting reconnect…');
    setTimeout(connect, 5000);
  });
};

module.exports = connectDB;