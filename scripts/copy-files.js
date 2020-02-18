/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const fse = require('fs-extra');
const glob = require('glob');

const packagePath = process.cwd();
const fromPath = path.join(packagePath, './build');
const toPath = path.join(packagePath, './lib');

async function includeFileInBuild(file) {
  const sourcePath = path.resolve(packagePath, file);
  const targetPath = path.resolve(fromPath, path.basename(file));
  await fse.copy(sourcePath, targetPath);
  console.log(`Copied ${sourcePath} to ${targetPath}`);
}

function mkDirByPathSync(targetDir, { recursive = false } = {}) {
  const sep = path.sep;
  const initDir = path.isAbsolute(targetDir) ? sep : __dirname;
  const baseDir = recursive ? __dirname : '.';

  return targetDir.split(sep).reduce((parentDir, childDir) => {
    const curDir = path.resolve(baseDir, parentDir, childDir);
    try {
      fs.mkdirSync(curDir, { recursive: true });
    } catch (err) {
      if (err.code === 'EEXIST') {
        // curDir already exists!
        return curDir;
      }

      // To avoid `EISDIR` error on Mac and `EACCES`-->`ENOENT` and `EPERM` on Windows.
      if (err.code === 'ENOENT') {
        // Throw the original parentDir error on curDir `ENOENT` failure.
        throw new Error(
          `EACCES: permission denied, mkdir '${parentDir}'`,
        );
      }

      const caughtErr =
        ['EACCES', 'EPERM', 'EISDIR'].indexOf(err.code) > -1;
      if (
        !caughtErr ||
        (caughtErr && curDir === path.resolve(targetDir))
      ) {
        throw err; // Throw if it's just the last created dir.
      }
    }

    return curDir;
  }, initDir);
}

try {
  mkDirByPathSync(fromPath);
} catch {}

/**
 * Puts a package.json into every immediate child directory of rootDir.
 * That package.json contains information about esm for bundlers so that imports
 *
 * It also tests that an this import can be used in typescript by checking
 * if an index.d.ts is present at that path.
 *
 * @param {string} rootDir
 */
async function createModulePackages({ from, to }) {
  const directoryPackages = glob
    .sync('*/index.js', { cwd: from })
    .map(path.dirname);

  await Promise.all(
    directoryPackages.map(async directoryPackage => {
      const packageJson = {
        sideEffects: false,
        module: path.join('../esm', directoryPackage, 'index.js'),
        typings: './index.d.ts',
      };
      const packageJsonPath = path.resolve(to, directoryPackage);

      const [typingsExist] = await Promise.all([
        fse.exists(path.join(to, directoryPackage, 'index.d.ts')),
        fse.writeFile(
          packageJsonPath + '/package.json',
          JSON.stringify(packageJson, null, 2),
        ),
      ]);

      if (!typingsExist) {
        throw new Error(
          `index.d.ts for ${directoryPackage} is missing`,
        );
      }

      return packageJsonPath;
    }),
  );
}

async function createPackageFile() {
  const packageData = await fse.readFile(
    path.resolve(packagePath, './package.json'),
    'utf8',
  );
  const {
    nyc,
    scripts,
    devDependencies,
    workspaces,
    ...packageDataOther
  } = JSON.parse(packageData);
  const newPackageData = {
    ...packageDataOther,
    private: false,
    main: './index.js',
    module: './esm/index.js',
    typings: './index.d.ts',
    'jsnext:main': './esm/index.js',
  };
  const targetPath = path.resolve(fromPath, './package.json');

  await fse.writeFile(
    targetPath,
    JSON.stringify(newPackageData, null, 2),
    'utf8',
  );
  console.log(`Created package.json in ${targetPath}`);

  return newPackageData;
}

async function prepend(file, string) {
  const data = await fse.readFile(file, 'utf8');
  await fse.writeFile(file, string + data, 'utf8');
}

async function addLicense(packageData) {
  const license = `/** @license Cosva-lab v${packageData.version}
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
`;
  await Promise.all(
    ['./index.js', './esm/index.js'].map(async file => {
      try {
        console.log(path.resolve(fromPath, file));
        await prepend(path.resolve(fromPath, file), license);
      } catch (err) {
        if (err.code === 'ENOENT') {
          console.log(`Skipped license for ${file}`);
        } else {
          throw err;
        }
      }
    }),
  );
}

async function typescriptCopy({ from, to }) {
  if (!(await fse.exists(to))) {
    console.warn(`path ${to} does not exists`);
    return [];
  }
  const files = glob.sync('**/*+(.js|.d.ts)', { cwd: from });

  const cmds = files.map(file =>
    fse.copy(path.resolve(from, file), path.resolve(to, file)),
  );
  return Promise.all(cmds);
}

async function run() {
  try {
    const packageData = await createPackageFile();

    await Promise.all(
      [
        './README.md',
        '../../CHANGELOG.md',
        '../../LICENSE',
      ].map(file => includeFileInBuild(file).catch(() => {})),
    );

    // TypeScript
    await typescriptCopy({ from: toPath, to: fromPath });

    await addLicense(packageData);

    await createModulePackages({ from: toPath, to: fromPath });
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

run();
