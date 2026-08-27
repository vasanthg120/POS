'use strict';

// Atomic sequence generator — used for human-readable, gap-free invoice
// numbers (INV-2026-0001, INV-2026-0002, ...). findOneAndUpdate with $inc is
// atomic at the Mongo level, so concurrent invoice generation across tenants
// can never collide on the same number.

const mongoose = require('mongoose');

const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

const Counter = mongoose.model('Counter', counterSchema);

const nextSequence = async (key) => {
  const doc = await Counter.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  );
  return doc.seq;
};

module.exports = { Counter, nextSequence };
