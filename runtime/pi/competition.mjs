export const COMPETITION_POLICY_SCHEMA_VERSION = '0.1.0';

export const COMPETITION_PROFILES = {
  editorial: {
    id: 'editorial',
    label: 'General editorial release',
    source_urls: [],
    deterministic_score_min: 88,
    vision_score_min: 80,
    deterministic_floors: {},
    vision_floors: { legibility: 75, source_legibility: 75, responsive_quality: 75 },
    forbidden_illustration_origins: [],
    manual_requirements: [],
  },
  snd47_infographics: {
    id: 'snd47_infographics',
    label: 'SND47 editorial infographics',
    source_urls: [
      'https://snd.org/snd-47-best-of-news-designcall-for-entries/',
      'https://snd.org/snd-2026-worlds-best-designed/',
    ],
    deterministic_score_min: 92,
    vision_score_min: 84,
    deterministic_floors: {
      clarity_information_flow: 88,
      hierarchy: 86,
      inclusion_accessibility: 86,
      responsive_execution: 86,
      craft_geometry: 84,
    },
    vision_floors: {
      hierarchy: 82,
      legibility: 84,
      composition: 82,
      source_legibility: 84,
      responsive_quality: 84,
      editorial_distinctiveness: 78,
    },
    forbidden_illustration_origins: ['generative_ai', 'mixed'],
    manual_requirements: [
      'Human editor must confirm the final reader-facing visual work satisfies the competition human-authorship rule.',
      'Submission screenshots or recordings should represent the actual reader experience on the entered platform.',
    ],
  },
  oja2026_visual: {
    id: 'oja2026_visual',
    label: 'OJA 2026 Excellence in Visual Digital Storytelling',
    source_urls: ['https://awards.journalists.org/awards/visual-digital-storytelling/'],
    deterministic_score_min: 92,
    vision_score_min: 85,
    deterministic_floors: {
      impact_story_focus: 85,
      clarity_information_flow: 86,
      effectiveness: 86,
      responsive_execution: 88,
      originality_variety: 78,
    },
    vision_floors: {
      hierarchy: 82,
      legibility: 84,
      composition: 84,
      responsive_quality: 88,
      editorial_distinctiveness: 82,
    },
    forbidden_illustration_origins: [],
    manual_requirements: [
      'Human editor must confirm the chosen media and interaction are materially effective for the story topic.',
      'Human editor must confirm originality is genuinely digital/mobile-native rather than a cosmetic format conversion.',
    ],
  },
  sigma2026: {
    id: 'sigma2026',
    label: 'Sigma Awards 2026',
    source_urls: ['https://www.sigmaawards.org/rules/'],
    deterministic_score_min: 90,
    vision_score_min: 82,
    deterministic_floors: {
      impact_story_focus: 84,
      clarity_information_flow: 86,
      effectiveness: 86,
      originality_variety: 78,
    },
    vision_floors: {
      legibility: 82,
      composition: 80,
      source_legibility: 82,
      editorial_distinctiveness: 78,
    },
    forbidden_illustration_origins: [],
    manual_requirements: [
      'Human editor must confirm the analysis exposes facts or issues of public interest and that methodology is sound.',
      'Human editor must confirm the project offers meaningful public service, community utility or field-level innovation.',
    ],
  },
  iib_awards: {
    id: 'iib_awards',
    label: 'Information is Beautiful Awards public rubric',
    source_urls: [
      'https://www.informationisbeautifulawards.com/news/594-2023-submissions-open-today',
      'https://www.informationisbeautifulawards.com/news/236-voting-what-our-judges-and-you-look-out-for-in-great-visualization',
    ],
    deterministic_score_min: 92,
    vision_score_min: 84,
    deterministic_floors: {
      impact_story_focus: 85,
      engagement: 82,
      clarity_information_flow: 88,
      effectiveness: 86,
      inclusion_accessibility: 85,
      originality_variety: 80,
    },
    vision_floors: {
      legibility: 84,
      composition: 84,
      visual_coherence: 82,
      color_contrast: 82,
      editorial_distinctiveness: 82,
    },
    forbidden_illustration_origins: [],
    manual_requirements: [
      'Human editor must independently validate that the underlying data is represented accurately.',
      'Human editor must assess whether aesthetic choices illuminate the subject rather than decorate it.',
    ],
  },
};

export const COMPETITION_PROFILE_IDS = Object.freeze(Object.keys(COMPETITION_PROFILES));

function text(value) { return String(value ?? '').trim(); }
function numeric(value) { return Number.isFinite(Number(value)) ? Number(value) : null; }

export function getCompetitionProfile(id = 'editorial') {
  const profile = COMPETITION_PROFILES[text(id) || 'editorial'];
  if (!profile) throw new Error(`Unknown competition profile '${id}'`);
  return profile;
}

function illustrationOrigins(assets = {}) {
  const rows = [];
  for (const [ref, asset] of Object.entries(assets)) {
    const manifest = asset?.manifest;
    if (manifest?.kind !== 'rich_illustration') continue;
    rows.push({ ref, origin: text(manifest?.provenance?.origin) || 'unknown' });
  }
  return rows;
}

function floorFailures(actual = {}, floors = {}, prefix = 'rubric') {
  const failures = [];
  for (const [key, minimum] of Object.entries(floors)) {
    const value = numeric(actual?.[key]);
    if (value === null || value < minimum) failures.push({ code: `${prefix}_floor`, dimension: key, actual: value, minimum });
  }
  return failures;
}

export function evaluateCompetitionProfile({ profile_id = 'editorial', spec = {}, assets = {}, deterministic_critic = {}, vision_critic = {} } = {}) {
  const profile = getCompetitionProfile(profile_id);
  const blockers = [];
  const warnings = [];
  const evidence = [];

  if (spec.competition_profile && spec.competition_profile !== profile.id) {
    blockers.push({ code: 'profile_mismatch', expected: spec.competition_profile, actual: profile.id });
  }
  if (deterministic_critic?.passed !== true) blockers.push({ code: 'deterministic_critic_not_passing' });
  if (vision_critic?.passed !== true) blockers.push({ code: 'vision_critic_not_passing' });

  const deterministicScore = numeric(deterministic_critic?.score);
  if (deterministicScore === null || deterministicScore < profile.deterministic_score_min) {
    blockers.push({ code: 'deterministic_score_below_profile', actual: deterministicScore, minimum: profile.deterministic_score_min });
  }
  const visionScore = numeric(vision_critic?.score);
  if (visionScore === null || visionScore < profile.vision_score_min) {
    blockers.push({ code: 'vision_score_below_profile', actual: visionScore, minimum: profile.vision_score_min });
  }

  blockers.push(...floorFailures(deterministic_critic?.rubric, profile.deterministic_floors, 'deterministic_rubric'));
  blockers.push(...floorFailures(vision_critic?.rubric, profile.vision_floors, 'vision_rubric'));

  const origins = illustrationOrigins(assets);
  for (const row of origins) {
    evidence.push({ kind: 'rich_illustration_origin', ...row });
    if (profile.forbidden_illustration_origins.includes(row.origin)) {
      blockers.push({ code: 'illustration_origin_ineligible', ref: row.ref, origin: row.origin, profile: profile.id });
    }
  }

  if (profile.id === 'snd47_infographics' && origins.some((row) => row.origin === 'software')) {
    warnings.push({ code: 'snd_human_authorship_attestation_required_for_software_generated_asset' });
  }
  if (spec.quality_target !== 'award' && profile.id !== 'editorial') {
    warnings.push({ code: 'competition_profile_without_award_quality_target' });
  }

  const machinePassed = blockers.length === 0;
  return {
    schema_version: COMPETITION_POLICY_SCHEMA_VERSION,
    profile: profile.id,
    label: profile.label,
    threshold_basis: 'internal_operational_proxy_not_official_jury_cutoff',
    source_urls: profile.source_urls,
    machine_passed: machinePassed,
    submission_ready: machinePassed && profile.manual_requirements.length === 0,
    blockers,
    warnings,
    manual_requirements: profile.manual_requirements,
    evidence,
    observed: {
      deterministic_score: deterministicScore,
      vision_score: visionScore,
      deterministic_rubric: deterministic_critic?.rubric ?? {},
      vision_rubric: vision_critic?.rubric ?? {},
    },
  };
}
