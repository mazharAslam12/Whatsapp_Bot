const EventEmitter = require("events");
class GlobalEvents extends EventEmitter {}

// Singleton instance to be used everywhere
const events = new GlobalEvents();

module.exports = events;
