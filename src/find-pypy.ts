import * as path from 'path';
import * as pypyInstall from './install-pypy';

import * as exec from '@actions/exec';
import * as semver from 'semver';
import * as core from '@actions/core';
import * as tc from '@actions/tool-cache';

const IS_WINDOWS = process.platform === 'win32';

interface IPyPyVersionSpec {
  pypyVersion: semver.Range;
  pythonVersion: semver.Range;
}

export async function findPyPyVersion(
  versionSpec: string,
  architecture: string
): Promise<{resolvedPyPyVersion: string; resolvedPythonVersion: string}> {
  let resolvedPyPyVersion = '';
  let resolvedPythonVersion = '';

  const pypyVersionSpec = parsePyPyVersion(versionSpec);
  if (IS_WINDOWS) {
    // TO-DO think about architecture
    architecture = 'x86';
  }

  let installDir: string | null = tc.find(
    'PyPy',
    pypyVersionSpec.pythonVersion.raw,
    architecture
  );

  if (installDir) {
    resolvedPyPyVersion = await getExactPyPyVersion(installDir);

    const isPyPyVersionSatisfies = semver.satisfies(
      resolvedPyPyVersion,
      pypyVersionSpec.pypyVersion
    );
    if (!isPyPyVersionSatisfies) {
      installDir = null;
    }
  }

  if (!installDir) {
    ({
      installDir,
      resolvedPythonVersion,
      resolvedPyPyVersion
    } = await pypyInstall.installPyPy(
      pypyVersionSpec.pypyVersion,
      pypyVersionSpec.pythonVersion,
      architecture
    ));

    await pypyInstall.createSymlinks(
      getPyPyBinaryPath(installDir),
      resolvedPythonVersion
    );
  }

  const pythonLocation = getPyPyBinaryPath(installDir);
  core.exportVariable('pythonLocation', pythonLocation);
  core.addPath(pythonLocation);

  return {resolvedPyPyVersion, resolvedPythonVersion};
}

async function getExactPyPyVersion(installDir: string) {
  const pypyBinary = getPyPyBinaryPath(installDir);
  let versionOutput = '';
  const pypyExecutables = path.join(pypyBinary, 'pypy');
  await exec.exec(
    `${pypyExecutables} -c "import sys;print('.'.join([str(int) for int in sys.pypy_version_info[0:3]]))"`,
    [],
    {
      ignoreReturnCode: true,
      silent: true,
      listeners: {
        stdout: (data: Buffer) => (versionOutput = data.toString())
      }
    }
  );

  core.debug(`PyPy version output is ${versionOutput}`);

  if (!versionOutput) {
    core.debug(`Enable to retrieve PyPy version from '${pypyBinary}/pypy'`); // polish error message
    return '';
  }

  return versionOutput;
}

/** Get PyPy binary location from the tool of installation directory
 *  - On Linux and macOS, the Python interpreter is in 'bin'.
 *  - On Windows, it is in the installation root.
 */
function getPyPyBinaryPath(installDir: string) {
  const _binDir = path.join(installDir, 'bin');
  return IS_WINDOWS ? installDir : _binDir;
}

function parsePyPyVersion(versionSpec: string) {
  const versions = versionSpec.split('-');
  // check that versions[1] and versions[2]
  // pypy-3.7
  // pypy-3.7-vx
  // TO-DO: should we print beatiful error message if versions parts are not semver or just throw exception
  if (versions.length === 0) {
    throw new Error('Please specify valid version Specification for PyPy.');
  }
  const pythonVersion = new semver.Range(versions[1]);
  const pypyVersion = new semver.Range(versions.length > 2 ? versions[2] : 'x');

  const data: IPyPyVersionSpec = {
    pypyVersion: pypyVersion,
    pythonVersion: pythonVersion
  };

  return data;
}
