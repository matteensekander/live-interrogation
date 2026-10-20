'use strict';

// Shared game constants. Everything here is safe to send to any client.

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 8;
const MAX_QUEUED_QUESTIONS = 2;
const MAX_FOLLOWUPS_PER_ROUND = 2;

const AVATARS = [
  { id: 'detective', name: 'Trench-Coat Detective' },
  { id: 'accountant', name: 'Nervous Accountant' },
  { id: 'singer', name: 'Lounge Singer' },
  { id: 'dame', name: 'Dame in Red' },
  { id: 'bookie', name: 'Sharp Bookie' },
  { id: 'cabbie', name: 'Night Cab Driver' },
  { id: 'cop', name: 'Retired Cop' },
  { id: 'pianist', name: 'Jazz Pianist' },
  { id: 'waitress', name: 'Diner Waitress' },
  { id: 'chemist', name: 'Lab Chemist' },
  { id: 'bellhop', name: 'Hotel Bellhop' },
  { id: 'painter', name: 'Street Painter' },
  { id: 'ogre', name: 'Sneaky Ogre' },
];

const COLORS = [
  '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71',
  '#1abc9c', '#3498db', '#9b59b6', '#e84393',
];

const ICONS = ['🤨', '✅'];

// role: who may use the card. 'suspect' | 'detective' | 'any'
const POWER_CARDS = {
  lawyer_up: {
    name: 'Lawyer Up',
    role: 'suspect',
    desc: 'Skip the current question. The chat reads "My client has no comment."',
  },
  polygraph: {
    name: 'Polygraph',
    role: 'detective',
    desc: 'The next question becomes a POLYGRAPH yes/no question. The suspect must answer truthfully.',
  },
  overtime: {
    name: 'Overtime',
    role: 'any',
    desc: 'Adds 60 seconds to the interrogation clock.',
  },
  rapid_fire: {
    name: 'Rapid Fire',
    role: 'detective',
    desc: 'For the next 3 questions, the suspect has only 8 seconds to answer.',
  },
};

// Phase lengths in seconds (before TIME_SCALE is applied on the server).
const TIMING = {
  briefing: 20,
  roles: 12,
  deliberation: 45,
  vote: 25,
  reveal: 30,
  scoreboard: 12,
  pause: 2,
  typing: 3,
  rapidAnswer: 8,
  overtimeBonus: 60,
};

const DEFAULT_SETTINGS = {
  rounds: 5,
  interrogationSecs: 240,
  answerSecs: 20,
  accomplice: false,
};

const LIMITS = {
  rounds: [1, 10],
  interrogationSecs: [60, 900],
  answerSecs: [5, 60],
};

module.exports = {
  MIN_PLAYERS,
  MAX_PLAYERS,
  MAX_QUEUED_QUESTIONS,
  MAX_FOLLOWUPS_PER_ROUND,
  AVATARS,
  COLORS,
  ICONS,
  POWER_CARDS,
  TIMING,
  DEFAULT_SETTINGS,
  LIMITS,
};
