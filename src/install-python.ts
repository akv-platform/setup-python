import * as path from 'path';
import * as core from '@actions/core';
import * as tc from '@actions/tool-cache';
import * as exec from '@actions/exec';
import {ExecOptions} from '@actions/exec/lib/interfaces';
import {IS_WINDOWS, IS_LINUX, isGhes} from './utils';

const TOKEN = core.getInput('token');
const AUTH = !TOKEN || isGhes() ? undefined : `token ${TOKEN}`;
const MANIFEST_REPO_OWNER = 'actions';
const MANIFEST_REPO_NAME = 'python-versions';
const MANIFEST_REPO_BRANCH = 'main';
export const MANIFEST_URL = `https://raw.githubusercontent.com/${MANIFEST_REPO_OWNER}/${MANIFEST_REPO_NAME}/${MANIFEST_REPO_BRANCH}/versions-manifest.json`;
import os = require('os')
import * as semver from 'semver'
import cp = require('child_process')

interface IToolReleaseFile {
  filename: string
  // 'aix', 'darwin', 'freebsd', 'linux', 'openbsd',
  // 'sunos', and 'win32'
  // platform_version is an optional semver filter
  // TODO: do we need distribution (e.g. ubuntu).
  //       not adding yet but might need someday.
  //       right now, 16.04 and 18.04 work
  platform: string
  platform_version?: string

  // 'arm', 'arm64', 'ia32', 'mips', 'mipsel',
  // 'ppc', 'ppc64', 's390', 's390x',
  // 'x32', and 'x64'.
  arch: string

  download_url: string
}

interface IToolRelease {
  version: string
  stable: boolean
  release_url: string
  files: IToolReleaseFile[]
}

function _getOsVersion(): string {
  // TODO: add windows and other linux, arm variants
  // right now filtering on version is only an ubuntu and macos scenario for tools we build for hosted (python)
  const plat = os.platform()
  let version = ''

  if (plat === 'darwin') {
    version = cp.execSync('sw_vers -productVersion').toString()
  } else if (plat === 'linux') {
    // lsb_release process not in some containers, readfile
    // Run cat /etc/lsb-release
    // DISTRIB_ID=Ubuntu
    // DISTRIB_RELEASE=18.04
    // DISTRIB_CODENAME=bionic
    // DISTRIB_DESCRIPTION="Ubuntu 18.04.4 LTS"
    const lsbContents = module.exports._readLinuxVersionFile()
    if (lsbContents) {
      const lines = lsbContents.split('\n')
      for (const line of lines) {
        const parts = line.split('=')
        if (
          parts.length === 2 &&
          (parts[0].trim() === 'VERSION_ID' ||
            parts[0].trim() === 'DISTRIB_RELEASE')
        ) {
          version = parts[1]
            .trim()
            .replace(/^"/, '')
            .replace(/"$/, '')
          break
        }
      }
    }
  }

  return version
}

async function _findMatch(
  versionSpec: string,
  stable: boolean,
  candidates: IToolRelease[],
  archFilter: string
): Promise<IToolRelease | undefined> {
  const platFilter = os.platform()

  let result: IToolRelease | undefined
  let match: IToolRelease | undefined

  let file: IToolReleaseFile | undefined
  for (const candidate of candidates) {
    const version = candidate.version

    core.debug(`check ${version} satisfies ${versionSpec}`)
    if (
      semver.satisfies(version, versionSpec) &&
      (!stable || candidate.stable === stable)
    ) {
      file = candidate.files.find(item => {
        core.debug(
          `item.arch:${item.arch}===archFilter:${archFilter} && item.platform:${item.platform}===platFilter:${platFilter}`
        )

        let chk = item.arch === archFilter && item.platform === platFilter
        core.debug(`chk = ${chk} item.platform_version = ${item.platform_version}`)
        if (chk && item.platform_version) {
          const osVersion = _getOsVersion()
          core.debug(`osVersion = ${osVersion} item.platform_version = ${item.platform_version}`)

          if (osVersion === item.platform_version) {
            chk = true
          } else {
            chk = semver.satisfies(osVersion, item.platform_version)
          }
          core.debug(`chk2 = ${chk}`)
        }

        return chk
      })

      if (file) {
        core.debug(`matched ${candidate.version}`)
        match = candidate
        break
      }
    }
  }

  if (match && file) {
    // clone since we're mutating the file list to be only the file that matches
    result = Object.assign({}, match)
    result.files = [file]
  }

  return result
}

export async function findReleaseFromManifest(
  semanticVersionSpec: string,
  architecture: string
): Promise<tc.IToolRelease | undefined> {
  const manifest: tc.IToolRelease[] = await tc.getManifestFromRepo(
    MANIFEST_REPO_OWNER,
    MANIFEST_REPO_NAME,
    AUTH,
    MANIFEST_REPO_BRANCH
  );
  // core.debug(`semanticVersionSpec=${semanticVersionSpec} manifest=${JSON.stringify(manifest)} architecture=${architecture}`)
  await _findMatch(
    semanticVersionSpec,
    false,
    manifest,
    architecture
  );
  return await tc.findFromManifest(
    semanticVersionSpec,
    false,
    manifest,
    architecture
  );
}

async function installPython(workingDirectory: string) {
  const options: ExecOptions = {
    cwd: workingDirectory,
    env: {
      ...process.env,
      ...(IS_LINUX && {LD_LIBRARY_PATH: path.join(workingDirectory, 'lib')})
    },
    silent: true,
    listeners: {
      stdout: (data: Buffer) => {
        core.info(data.toString().trim());
      },
      stderr: (data: Buffer) => {
        core.error(data.toString().trim());
      }
    }
  };

  if (IS_WINDOWS) {
    await exec.exec('powershell', ['./setup.ps1'], options);
  } else {
    await exec.exec('bash', ['./setup.sh'], options);
  }
}

export async function installCpythonFromRelease(release: tc.IToolRelease) {
  const downloadUrl = release.files[0].download_url;

  core.info(`Download from "${downloadUrl}"`);
  const pythonPath = await tc.downloadTool(downloadUrl, undefined, AUTH);
  core.info('Extract downloaded archive');
  let pythonExtractedFolder;
  if (IS_WINDOWS) {
    pythonExtractedFolder = await tc.extractZip(pythonPath);
  } else {
    pythonExtractedFolder = await tc.extractTar(pythonPath);
  }

  core.info('Execute installation script');
  await installPython(pythonExtractedFolder);
}
