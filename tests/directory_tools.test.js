
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { createDirectoryTool, removeDirectoryTool, moveDirectoryTool } from '../src/tools/directory_tools.js';
import * as security from '../src/utils/security.js';

vi.mock('fs', () => ({
  promises: {
    mkdir: vi.fn(),
    rmdir: vi.fn(),
    rm: vi.fn(),
    rename: vi.fn(),
  },
}));

vi.mock('../src/utils/security.js', () => ({
  ensureWriteAllowed: vi.fn(),
  ensureReadAllowed: vi.fn(),
}));

describe('Directory Tools', () => {
  const createDirectory = createDirectoryTool;
  const removeDirectory = removeDirectoryTool;
  const moveDirectory = moveDirectoryTool;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createDirectory', () => {
    it('should create a directory recursively by default', async () => {
      const dirPath = 'new/test/dir';
      const absolutePath = path.resolve(dirPath);
      await createDirectory.func({ path: dirPath });

      expect(security.ensureWriteAllowed).toHaveBeenCalledWith(absolutePath);
      expect(fs.mkdir).toHaveBeenCalledWith(absolutePath, { recursive: true });
    });

    it('should handle the recursive flag when set to false', async () => {
      const dirPath = 'new-dir';
      const absolutePath = path.resolve(dirPath);
      await createDirectory.func({ path: dirPath, recursive: false });

      expect(security.ensureWriteAllowed).toHaveBeenCalledWith(absolutePath);
      expect(fs.mkdir).toHaveBeenCalledWith(absolutePath, { recursive: false });
    });

    it('should throw an error if mkdir fails', async () => {
      const dirPath = 'bad/dir';
      const error = new Error('FS Error');
      fs.mkdir.mockRejectedValue(error);

      await expect(createDirectory.func({ path: dirPath })).rejects.toThrow(`Failed to create directory ${path.resolve(dirPath)}: FS Error`);
    });
  });

  describe('removeDirectory', () => {
    it('should remove an empty directory by default', async () => {
      const dirPath = 'empty-dir';
      const absolutePath = path.resolve(dirPath);
      await removeDirectory.func({ path: dirPath });

      expect(security.ensureWriteAllowed).toHaveBeenCalledWith(absolutePath);
      expect(fs.rmdir).toHaveBeenCalledWith(absolutePath);
      expect(fs.rm).not.toHaveBeenCalled();
    });

    it('should remove a directory recursively when specified', async () => {
      const dirPath = 'non-empty-dir';
      const absolutePath = path.resolve(dirPath);
      await removeDirectory.func({ path: dirPath, recursive: true });

      expect(security.ensureWriteAllowed).toHaveBeenCalledWith(absolutePath);
      expect(fs.rm).toHaveBeenCalledWith(absolutePath, { recursive: true, force: true });
      expect(fs.rmdir).not.toHaveBeenCalled();
    });

    it('should throw a specific error for non-empty directory without recursive flag', async () => {
      const dirPath = 'non-empty-dir';
      const error = new Error('Directory not empty');
      error.code = 'ENOTEMPTY';
      fs.rmdir.mockRejectedValue(error);

      await expect(removeDirectory.func({ path: dirPath })).rejects.toThrow('Failed to remove directory');
    });
  });

  describe('moveDirectory', () => {
    it('should move a directory from source to destination', async () => {
      const source = 'old/path';
      const destination = 'new/path';
      const absoluteSource = path.resolve(source);
      const absoluteDestination = path.resolve(destination);

      await moveDirectory.func({ source, destination });

      expect(security.ensureReadAllowed).toHaveBeenCalledWith(absoluteSource);
      expect(security.ensureWriteAllowed).toHaveBeenCalledWith(absoluteSource);
      expect(security.ensureWriteAllowed).toHaveBeenCalledWith(absoluteDestination);
      expect(fs.rename).toHaveBeenCalledWith(absoluteSource, absoluteDestination);
    });

    it('should throw an error if rename fails', async () => {
      const source = 'a';
      const destination = 'b';
      const error = new Error('Rename failed');
      fs.rename.mockRejectedValue(error);

      await expect(moveDirectory.func({ source, destination })).rejects.toThrow('Failed to move directory: Rename failed');
    });
  });
});
