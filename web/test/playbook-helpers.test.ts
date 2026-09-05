import { describe, expect, it } from 'vitest';
import {
  areaLabel,
  areaTone,
  deployProfileLabel,
  describeInputs,
  inputKind,
  noteInputNames,
  personaToolLabel,
  personaToolMarkerText,
  runStatusLabel,
  runStatusTone,
  validateAbsoluteDir,
  validateHostInput,
  validateJsonText,
  validatePortInput,
  validateProfileName,
} from '../src/lib/playbook-helpers.js';

const NOTE_INPUT = { name: 'noteId', hint: 'an existing note to summarize', optional: true };
const TOPIC_INPUT = { name: 'topic', hint: 'what to research' };
const CSV_INPUT = { name: 'csv', hint: 'paste the CSV data here' };
const JSON_INPUT = { name: 'spec', hint: 'token spec as JSON' };

describe('area labels + tones', () => {
  it('labels every known playbook area', () => {
    expect(areaLabel('research')).toBe('Research');
    expect(areaLabel('vibe-code')).toBe('Vibe code');
    expect(areaLabel('docgen')).toBe('Docgen');
    expect(areaLabel('email')).toBe('Email');
    expect(areaLabel('presentation')).toBe('Presentation');
    expect(areaLabel('analysis')).toBe('Analysis');
    expect(areaLabel('design-prototype')).toBe('Design prototype');
    expect(areaLabel('ship')).toBe('Ship');
  });

  it('falls back to the raw id for unknown areas', () => {
    expect(areaLabel('video')).toBe('video');
  });

  it('maps tones from the semantic set only (neutral/accent/success)', () => {
    expect(areaTone('vibe-code')).toBe('accent');
    expect(areaTone('design-prototype')).toBe('accent');
    expect(areaTone('ship')).toBe('success');
    expect(areaTone('research')).toBe('neutral');
    expect(areaTone('docgen')).toBe('neutral');
    expect(areaTone('email')).toBe('neutral');
    expect(areaTone('presentation')).toBe('neutral');
    expect(areaTone('analysis')).toBe('neutral');
    expect(areaTone('unknown-area')).toBe('neutral');
  });
});

describe('input schema helpers', () => {
  it('describes inputs in schema order with optional markers', () => {
    expect(describeInputs([])).toBe('No inputs');
    expect(describeInputs([TOPIC_INPUT])).toBe('1 input · topic');
    expect(describeInputs([NOTE_INPUT])).toBe('1 input · noteId (optional)');
    expect(describeInputs([TOPIC_INPUT, NOTE_INPUT, CSV_INPUT])).toBe(
      '3 inputs · topic, noteId (optional), csv',
    );
  });

  it('picks note pickers from hints that ask for a note', () => {
    expect(inputKind(NOTE_INPUT)).toBe('note');
    expect(inputKind(TOPIC_INPUT)).toBe('text');
    expect(noteInputNames([NOTE_INPUT, TOPIC_INPUT])).toEqual(['noteId']);
    expect(noteInputNames([])).toEqual([]);
  });

  it('renders long freeform + JSON hints as textarea/json', () => {
    expect(inputKind(CSV_INPUT)).toBe('textarea');
    expect(inputKind(JSON_INPUT)).toBe('json');
    expect(inputKind({ name: 'draft', hint: 'draft the body of the email' })).toBe('textarea');
    expect(inputKind({ name: 'x', hint: 'choose' })).toBe('text');
  });

  it('validates JSON input text', () => {
    expect(validateJsonText('{"a":1}')).toBeNull();
    expect(validateJsonText('')).toBe('Required.');
    expect(validateJsonText('{nope')).toBe('Enter valid JSON.');
  });
});

describe('host + dir validation', () => {
  it('validateHostInput requires a non-empty hostname without spaces', () => {
    expect(validateHostInput('')).toBe('Host is required.');
    expect(validateHostInput('   ')).toBe('Host is required.');
    expect(validateHostInput('enter.ne1.dev')).toBeNull();
    expect(validateHostInput('10.0.0.5')).toBeNull();
    expect(validateHostInput('enter ne1.dev')).toContain('must not contain spaces');
  });

  it('validateProfileName rejects empty and spaced names', () => {
    expect(validateProfileName('')).toBe('Name is required.');
    expect(validateProfileName('prod box')).toBe('Name must not contain spaces.');
    expect(validateProfileName('prod')).toBeNull();
  });

  it('validatePortInput accepts empty (default 22) and bounded integers', () => {
    expect(validatePortInput('')).toBeNull();
    expect(validatePortInput('22')).toBeNull();
    expect(validatePortInput('0')).toBe('Port must be between 1 and 65535.');
    expect(validatePortInput('70000')).toBe('Port must be between 1 and 65535.');
    expect(validatePortInput('abc')).toBe('Port must be a whole number.');
  });

  it('validateAbsoluteDir requires an absolute path', () => {
    expect(validateAbsoluteDir('')).toBe('Path is required.');
    expect(validateAbsoluteDir('relative/dir')).toContain('absolute');
    expect(validateAbsoluteDir('/home/me/projects/foo')).toBeNull();
    // Windows drive-letter absolute paths are valid too (grant roots on the
    // documented Windows dev host are drive-letter absolute).
    expect(validateAbsoluteDir('C:\\Projects\\app')).toBeNull();
    expect(validateAbsoluteDir('C:/Projects/app')).toBeNull();
    expect(validateAbsoluteDir('D:\\x')).toBeNull();
  });
});

describe('run status labels', () => {
  it('labels every playbook_runs status', () => {
    expect(runStatusLabel('running')).toBe('Running');
    expect(runStatusLabel('done')).toBe('Complete');
    expect(runStatusLabel('error')).toBe('Failed');
    expect(runStatusLabel('loop_exhausted')).toBe('Loop limit reached');
    expect(runStatusLabel(null)).toBe('Running');
    expect(runStatusLabel('bogus')).toBe('bogus');
  });

  it('maps tones from semantic tokens', () => {
    expect(runStatusTone('done')).toBe('ok');
    expect(runStatusTone('error')).toBe('danger');
    expect(runStatusTone('loop_exhausted')).toBe('warn');
    expect(runStatusTone('running')).toBe('running');
    expect(runStatusTone(null)).toBe('running');
  });
});

describe('deploy profile labels', () => {
  it('summarizes host + user/port and the optional base dir', () => {
    expect(
      deployProfileLabel({
        id: 'dp-1',
        name: 'prod',
        kind: 'docker-ssh',
        host: 'enter.ne1.dev',
        username: 'root',
        port: 22,
        remoteBaseDir: null,
        createdAt: 1,
        updatedAt: 1,
      }),
    ).toBe('root@enter.ne1.dev:22');
    expect(
      deployProfileLabel({
        id: 'dp-2',
        name: 'home',
        kind: 'docker-ssh',
        host: '10.0.0.5',
        username: null,
        port: 2222,
        remoteBaseDir: '/opt/apps',
        createdAt: 1,
        updatedAt: 1,
      }),
    ).toBe('10.0.0.5:2222 → /opt/apps');
  });
});

describe('persona tool markers', () => {
  it('labels known broker tools and falls back to the raw id', () => {
    expect(personaToolLabel('files.read')).toBe('Read file');
    expect(personaToolLabel('some.new.tool')).toBe('some.new.tool');
  });

  it('builds marker text per decision with the queue hint on queued', () => {
    const opts = { personaName: 'Builder' };
    expect(personaToolMarkerText('files.read', 'executed', opts)).toBe('Builder ran Read file.');
    expect(personaToolMarkerText('files.read', 'queued', opts)).toBe(
      'Builder asked to Read file — approve it in the queue to continue.',
    );
    expect(personaToolMarkerText('files.apply', 'refused', opts)).toBe(
      'Builder was not allowed to run Apply edit.',
    );
    expect(personaToolMarkerText('files.apply', 'refused', { personaName: 'Builder', reason: 'high risk' })).toBe(
      'Builder was not allowed to run Apply edit (high risk).',
    );
    expect(personaToolMarkerText('files.read', 'queued')).toContain('The persona asked to');
  });
});
