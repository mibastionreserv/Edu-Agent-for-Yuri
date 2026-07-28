import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  describe, it, expect, beforeAll,
} from 'vitest';
import request from 'supertest';
import { newDb } from 'pg-mem';

const __dirname = dirname(fileURLToPath(import.meta.url));
process.env.CONTENT_DIR = join(__dirname, '..', '..', 'course-content');
process.env.JWT_SECRET = 'test-only-secret';

const { createApp } = await import('../src/app.js');
const { runMigrations } = await import('../src/migrate.js');

let app;

beforeAll(async () => {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  await runMigrations(pool);
  app = createApp(pool);
});

describe('API flow: course -> auth -> progress -> ask', () => {
  const creds = { email: 'qa.user@example.com', password: 'super-secret-123', displayName: 'QA User' };
  let token;

  it('serves the localized course listing (4 languages)', async () => {
    const res = await request(app).get('/api/course?lang=en');
    expect(res.status).toBe(200);
    expect(res.body.courseId).toBe('practical-scrum');
    expect(res.body.modules.length).toBeGreaterThan(0);
    expect(res.body.supportedLanguages).toEqual(['en', 'de', 'it', 'el']);
  });

  it('serves a module with segments and a knowledge check in Greek', async () => {
    const res = await request(app).get('/api/modules/m1-roles?lang=el');
    expect(res.status).toBe(200);
    expect(res.body.language).toBe('el');
    expect(res.body.segments.length).toBeGreaterThan(0);
    expect(res.body.check).toBeTruthy();
    expect(res.body.check.items.length).toBeGreaterThan(0);
  });

  it('rejects weak passwords on registration', async () => {
    const res = await request(app).post('/api/auth/register').send({ email: 'a@b.co', password: 'short' });
    expect(res.status).toBe(400);
  });

  it('registers a new account (created via the API, not seeded)', async () => {
    const res = await request(app).post('/api/auth/register').send(creds);
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    token = res.body.token;
  });

  it('does not allow duplicate registration', async () => {
    const res = await request(app).post('/api/auth/register').send(creds);
    expect(res.status).toBe(409);
  });

  it('logs in with correct credentials', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: creds.email, password: creds.password });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it('rejects login with a wrong password', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: creds.email, password: 'wrong-password' });
    expect(res.status).toBe(401);
  });

  it('starts a guest session without a password', async () => {
    const res = await request(app).post('/api/auth/guest');
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
  });

  it('requires auth for progress', async () => {
    const res = await request(app).get('/api/progress');
    expect(res.status).toBe(401);
  });

  it('persists and reads back progress', async () => {
    const put = await request(app)
      .put('/api/progress')
      .set('Authorization', `Bearer ${token}`)
      .send({ courseId: 'practical-scrum', moduleId: 'm2-events', segmentIndex: 1, lang: 'it', avatarId: 'mira' });
    expect(put.status).toBe(200);

    const get = await request(app).get('/api/progress').set('Authorization', `Bearer ${token}`);
    expect(get.status).toBe(200);
    expect(get.body.module_id).toBe('m2-events');
    expect(get.body.segment_index).toBe(1);
    expect(get.body.avatar_id).toBe('mira');
    expect(get.body.lang).toBe('it');
  });

  it('answers an on-topic question and logs it', async () => {
    const res = await request(app)
      .post('/api/ask')
      .set('Authorization', `Bearer ${token}`)
      .send({ moduleId: 'm2-events', lang: 'en', question: 'How long is the Daily Scrum?' });
    expect(res.status).toBe(200);
    expect(res.body.topicality).toBe('on');
    expect(res.body.answer.toLowerCase()).toMatch(/fifteen/);

    const list = await request(app).get('/api/questions').set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.length).toBeGreaterThanOrEqual(1);
  });

  it('deflects an off-topic question', async () => {
    const res = await request(app)
      .post('/api/ask')
      .set('Authorization', `Bearer ${token}`)
      .send({ moduleId: 'm2-events', lang: 'en', question: 'Who won the football match yesterday?' });
    expect(res.status).toBe(200);
    expect(res.body.topicality).toBe('off');
  });
});
