const express = require('express');

const router = express.Router();

let users = [
  { id: 1, name: 'Ada' },
  { id: 2, name: 'Alan' }
];

router.get('/users', (_req, res) => res.json(users));

router.get('/users/:id', (req, res) => {
  const user = users.find((u) => u.id === Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'not found' });
  res.json(user);
});

router.post('/users', (req, res) => {
  const user = { id: users.length + 1, name: req.body.name };
  users.push(user);
  res.status(201).json(user);
});

module.exports = { router };