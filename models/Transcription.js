const mongoose = require("mongoose");

const TranscriptionSchema = new mongoose.Schema({
  audioFile: {
    type: String,
    required: true,
  },
  transcriptionText: {
    type: String,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("Transcription", TranscriptionSchema);
