import * as fs from 'node:fs';
import * as p from 'node:path';
import { DOMParser } from 'xmldom';

const REGEXP_MATCH_NOTHING = /a^/;

export function currentFolderName(): string {
  return p.basename(p.resolve(process.cwd()));
}

export function findFiles(
  includePattern: string,
  includeFlags?: string,
  excludePattern?: string,
  excludeFlags?: string
) {
  const results = [];
  const stack = ['.'];

  const includeRegexp = new RegExp(includePattern, includeFlags);
  const excludeRegexp = excludePattern
    ? new RegExp(excludePattern, excludeFlags)
    : REGEXP_MATCH_NOTHING;

  while (stack.length > 0) {
    const currentPath = stack.pop() as string;
    const paths = fs
      .readdirSync(currentPath)
      .map((nextPath) => p.join(currentPath, nextPath));
    const dirs = paths.filter(
      (nextPath) =>
        !excludeRegexp.test(nextPath) && fs.lstatSync(nextPath).isDirectory()
    );
    const files = paths.filter(
      (nextPath) =>
        !excludeRegexp.test(nextPath) &&
        fs.lstatSync(nextPath).isFile() &&
        includeRegexp.test(nextPath.replace(/\\/g, '/'))
    );
    results.push(...files);
    stack.push(...dirs);
  }
  return results;
}

export function readJson(path: string) {
  try {
    const buffer = fs.readFileSync(path);
    return JSON.parse(buffer.toString());
  } catch (err) {
    return undefined;
  }
}

export function readXmlAsDom(path: string) {
  const buffer = fs.readFileSync(path);
  return new DOMParser().parseFromString(buffer.toString());
}

export function readFile(path: string) {
  const buffer = fs.readFileSync(path);
  return buffer.toString();
}
