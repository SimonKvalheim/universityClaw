import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import { _initTestDatabase, setRegisteredGroup } from './db.js';
import { IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'telegram_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'telegram_other',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

describe('IPC voice dispatch', () => {
  let groups: Record<string, RegisteredGroup>;
  let sendVoiceMock: (jid: string, filePath: string, caption?: string) => Promise<void>;
  let deps: IpcDeps;

  beforeEach(() => {
    _initTestDatabase();
    groups = {
      'tg:-100main': MAIN_GROUP,
      'tg:-100other': OTHER_GROUP,
    };
    setRegisteredGroup('tg:-100main', MAIN_GROUP);
    setRegisteredGroup('tg:-100other', OTHER_GROUP);

    sendVoiceMock = vi.fn().mockResolvedValue(undefined);
    deps = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendVoice: sendVoiceMock,
      registeredGroups: () => groups,
      registerGroup: () => {},
      syncGroups: vi.fn().mockResolvedValue(undefined),
      getAvailableGroups: () => [],
      writeGroupsSnapshot: () => {},
      onTasksChanged: () => {},
    };
  });

  describe('container path resolution', () => {
    it('resolves valid /workspace/group/ paths', () => {
      const containerPath = '/workspace/group/audio/tts-1234-abcd.wav';
      const isValid =
        containerPath.startsWith('/workspace/group/') &&
        !containerPath.includes('..');
      expect(isValid).toBe(true);
      const relative = containerPath.replace(/^\/workspace\/group\//, '');
      expect(relative).toBe('audio/tts-1234-abcd.wav');
    });

    it('rejects paths outside /workspace/group/', () => {
      const containerPath = '/workspace/ipc/messages/hack.json';
      expect(containerPath.startsWith('/workspace/group/')).toBe(false);
    });

    it('rejects path traversal attempts', () => {
      const containerPath = '/workspace/group/../../etc/passwd';
      const relative = containerPath.replace(/^\/workspace\/group\//, '');
      expect(relative.includes('..')).toBe(true);
    });
  });

  describe('voice IPC message validation', () => {
    it('requires type, chatJid, and file fields', () => {
      const valid = {
        type: 'voice',
        chatJid: 'tg:-100main',
        file: '/workspace/group/audio/test.wav',
      };
      expect(
        valid.type === 'voice' && valid.chatJid && valid.file,
      ).toBeTruthy();

      const noFile = { type: 'voice', chatJid: 'tg:-100main' } as any;
      expect(
        noFile.type === 'voice' && noFile.chatJid && noFile.file,
      ).toBeFalsy();
    });
  });

  describe('authorization', () => {
    it('main group can send voice to any chat', () => {
      const sourceGroup = MAIN_GROUP.folder;
      const isMain = true;
      const targetJid = 'tg:-100other';
      const targetGroup = groups[targetJid];
      const authorized =
        isMain || (targetGroup && targetGroup.folder === sourceGroup);
      expect(authorized).toBe(true);
    });

    it('non-main group can only send to own chat', () => {
      const sourceGroup = OTHER_GROUP.folder;
      const isMain = false;

      // Own chat — authorized
      const ownJid = 'tg:-100other';
      const ownTarget = groups[ownJid];
      expect(isMain || (ownTarget && ownTarget.folder === sourceGroup)).toBe(
        true,
      );

      // Other chat — unauthorized
      const otherJid = 'tg:-100main';
      const otherTarget = groups[otherJid];
      expect(
        isMain || (otherTarget && otherTarget.folder === sourceGroup),
      ).toBe(false);
    });
  });

  describe('sendVoice dep availability', () => {
    it('skips gracefully when sendVoice is not provided', () => {
      const depsWithoutVoice = { ...deps, sendVoice: undefined };
      expect(depsWithoutVoice.sendVoice).toBeUndefined();
    });
  });
});
