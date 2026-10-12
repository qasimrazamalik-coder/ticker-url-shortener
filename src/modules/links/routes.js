const express = require('express');
const { z } = require('zod');
const config = require('../../config');
const { validate } = require('../../middleware/validate');
const { rateLimit } = require('../../middleware/rateLimit');
const svc = require('./service');

const router = express.Router();
const idParam = z.object({ id: z.coerce.number().int().positive() });
const when = z.string().datetime({ offset: true });

const createLimit = rateLimit({ name: 'create-link', capacity: config.linkRateBurst, keyFn: (req) => req.user.id });

router.post('/', createLimit, validate({ body: z.object({
  url: z.string().min(1).max(2048),
  alias: z.string().trim().max(32).optional().transform((v) => v || undefined),
  title: z.string().trim().max(120).default(''),
  expiresAt: when.nullable().default(null),
  maxClicks: z.number().int().min(1).max(1000000).nullable().default(null),
}) }), async (req, res) => {
  res.status(201).json(await svc.createLink(req.user, req.valid.body));
});

router.get('/', validate({ query: z.object({
  q: z.string().trim().max(100).optional(),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}) }), async (req, res) => {
  res.json(await svc.listLinks(req.user, req.valid.query));
});

router.get('/:id', validate({ params: idParam }), async (req, res) => {
  res.json(await svc.getLink(req.user, req.valid.params.id));
});

router.patch('/:id', validate({ params: idParam, body: z.object({
  url: z.string().min(1).max(2048).optional(),
  title: z.string().trim().max(120).optional(),
  expiresAt: when.nullable().optional(),
  maxClicks: z.number().int().min(1).max(1000000).nullable().optional(),
  disabled: z.boolean().optional(),
}).strict() }), async (req, res) => {
  res.json(await svc.updateLink(req.user, req.valid.params.id, req.valid.body));
});

router.delete('/:id', validate({ params: idParam }), async (req, res) => {
  await svc.deleteLink(req.user, req.valid.params.id);
  res.status(204).end();
});

module.exports = { router };
