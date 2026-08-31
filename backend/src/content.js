import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { chunkKnowledge } from './qa.js';

export function contentDir() {
  return process.env.CONTENT_DIR || join(process.cwd(), '..', 'course-content');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadConfig() {
  return readJson(join(contentDir(), 'course.config.json'));
}

export function loadUiStrings(lang) {
  const cfg = loadConfig();
  const use = cfg.supportedLanguages.includes(lang) ? lang : cfg.defaultLanguage;
  return readJson(join(contentDir(), 'ui-strings', `${use}.json`));
}

export function loadAvatars(lang) {
  const { avatars } = readJson(join(contentDir(), 'avatars', 'avatars.json'));
  return avatars.map((a) => ({
    id: a.id,
    name: a.name[lang] || a.name.en,
    role: a.role[lang] || a.role.en,
    desc: a.desc[lang] || a.desc.en,
    voice: a.voice[lang] || a.voice.en,
    model: a.model || null,
    source: a.source || null,
  }));
}

// Returns the resolved course: config + ordered, localized module summaries.
export function loadCourse(lang) {
  const cfg = loadConfig();
  const use = cfg.supportedLanguages.includes(lang) ? lang : cfg.defaultLanguage;
  const modules = cfg.moduleSequence
    .map((id) => {
      const modPath = join(contentDir(), id, 'module.json');
      if (!existsSync(modPath)) return null;
      const m = readJson(modPath);
      return {
        id: m.id,
        title: m.title[use] || m.title.en,
        order: m.order,
        estimatedMinutes: m.estimatedMinutes,
        summary: (m.summary && (m.summary[use] || m.summary.en)) || '',
      };
    })
    .filter(Boolean);

  return {
    courseId: cfg.courseId,
    title: cfg.title[use] || cfg.title.en,
    language: use,
    supportedLanguages: cfg.supportedLanguages,
    availableAvatars: cfg.availableAvatars,
    playback: cfg.playback,
    avatars: loadAvatars(use),
    modules,
  };
}

// Returns a single module for playback: script segments + knowledge chunks +
// resolved asset URLs for the whiteboard.
export function loadModule(moduleId, lang) {
  const cfg = loadConfig();
  if (!cfg.moduleSequence.includes(moduleId)) return null;
  const use = cfg.supportedLanguages.includes(lang) ? lang : cfg.defaultLanguage;

  const base = join(contentDir(), moduleId);
  const modPath = join(base, 'module.json');
  if (!existsSync(modPath)) return null;
  const m = readJson(modPath);

  const scriptRel = (m.scripts && (m.scripts[use] || m.scripts.en)) || null;
  const script = scriptRel && existsSync(join(base, scriptRel))
    ? readJson(join(base, scriptRel))
    : { segments: [] };

  const knowRel = (m.knowledgeBase && (m.knowledgeBase[use] || m.knowledgeBase.en)) || null;
  const knowledge = knowRel && existsSync(join(base, knowRel))
    ? readFileSync(join(base, knowRel), 'utf8')
    : '';

  const assetBase = `/content/${moduleId}/assets/${use}`;

  return {
    id: m.id,
    title: m.title[use] || m.title.en,
    order: m.order,
    language: use,
    estimatedMinutes: m.estimatedMinutes,
    assetBaseUrl: assetBase,
    outcomes: script.outcomes || [],
    segments: script.segments || [],
    check: script.check || null,
    knowledgeChunks: chunkKnowledge(knowledge),
  };
}
