#!/usr/bin/env node
import 'dotenv/config';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { runDiagnostics } from '../src/diagnostics/onboarding.js';
import { writeFile, readFile, listDirectory } from '../src/tools/file_system.js';

const createTempWorkspace = async () => {
  const prefix = path.join(os.tmpdir(), 'aira-smoke-');
  return fs.mkdtemp(prefix);
};

const main = async () => {
  const previousWriteRoots = process.env.AIRA_FS_ADDITIONAL_WRITE_ROOTS;
  const previousReadRoots = process.env.AIRA_FS_ADDITIONAL_READ_ROOTS;
  let tempRoot;

  try {
    const diagnosticResult = await runDiagnostics({
      autoFix: false,
      skipPull: true,
      skipSelfCheck: true,
      reportPath: null,
      silent: true,
      context: 'smoke',
    });

    if (!diagnosticResult.success) {
      console.error('Smoke test: prerequisites missing.');
      diagnosticResult.friction.forEach(({ message }, index) => {
        console.error(`  ${index + 1}. ${message}`);
      });
      process.exitCode = 1;
      return;
    }

    tempRoot = await createTempWorkspace();
    process.env.AIRA_FS_ADDITIONAL_WRITE_ROOTS = previousWriteRoots
      ? `${previousWriteRoots},${tempRoot}`
      : tempRoot;
    process.env.AIRA_FS_ADDITIONAL_READ_ROOTS = previousReadRoots
      ? `${previousReadRoots},${tempRoot}`
      : tempRoot;

    const sampleFile = path.join(tempRoot, 'sample.txt');
    const payload = `AIra smoke check ${Date.now()}`;

    const writeMessage = await writeFile(sampleFile, payload);
    if (!/Successfully/.test(writeMessage)) {
      throw new Error(`Smoke test: writeFile failed - ${writeMessage}`);
    }

    const content = await readFile(sampleFile);
    if (content !== payload) {
      throw new Error('Smoke test: readFile returned unexpected content.');
    }

    const entries = await listDirectory(tempRoot);
    if (!Array.isArray(entries) || !entries.includes('sample.txt')) {
      throw new Error('Smoke test: listDirectory did not return created file.');
    }

    console.log('Index command smoke test placeholder: skipping (feature in development).');
    console.log('AIra smoke test passed.');
  } catch (error) {
    console.error('AIra smoke test failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
    if (previousWriteRoots === undefined) {
      delete process.env.AIRA_FS_ADDITIONAL_WRITE_ROOTS;
    } else {
      process.env.AIRA_FS_ADDITIONAL_WRITE_ROOTS = previousWriteRoots;
    }
    if (previousReadRoots === undefined) {
      delete process.env.AIRA_FS_ADDITIONAL_READ_ROOTS;
    } else {
      process.env.AIRA_FS_ADDITIONAL_READ_ROOTS = previousReadRoots;
    }
  }
};

main();
