const express = require('express');
const { router } = require('./src/routes');

const app = express();
app.use(express.json());
app.use('/api', router);

app.get('/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`bench api on ${PORT}`));