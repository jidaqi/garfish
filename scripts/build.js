// umd: 打包成 umd 格式，依赖包打进来
// esm-builder: 打包成 esm，依赖包不打进来
// esm-browser: 打包成 esm，依赖包一起打进来
// cjs: 打包成 commonjs，依赖包不打进来
// cjs.prod: 打包成 commonjs，依赖包不打进来，有些环境变量不同

const path = require('path');
const chalk = require('chalk');
const fs = require('fs-extra');
const execa = require('execa');
const {
  getDeps,
  allTargets,
  clearConsole,
  matchPkgName,
  fuzzyMatchTarget,
} = require('./utils');

const args = require('minimist')(process.argv.slice(2));
const targets = args._;
const watch = args.watch || args.w;
const formats = args.formats || args.f;
const noCheck = args.nocheck || args.n;
const sourceMap = args.sourcemap || args.s;
const mergeTypes = args.mergetypes || args.m;
const noExternal = args.noExternal || args.e; // 把 garfish 的子包都打进去

clearConsole();
run();

async function run() {
  const buildAll = async (targets) => {
    for (const target of targets) {
      await build(target);
    }
  };

  if (!targets.length) {
    await buildAll(allTargets);
  } else {
    await buildAll(fuzzyMatchTarget(targets));
  }
}

async function build(target) {
  const pkgDir = path.resolve(`packages/core/${target}`);
  const pkg = require(`${pkgDir}/package.json`);

  if (pkg.private) {
    return;
  }

  if (!formats) {
    await fs.remove(`${pkgDir}/dist`);
  }

  await execa(
    'rollup',
    [
      watch ? '-wc' : '-c',
      '--environment',
      [
        'ENV:production',
        `TARGET:${target}`,
        `CHECK:${!noCheck}`,
        formats ? `FORMATS:${formats}` : '',
        sourceMap ? 'SOURCE_MAP:true' : '',
        noExternal ? 'NO_EXTERNAL:true' : '',
      ]
        .filter(Boolean)
        .join(','),
    ],
    { stdio: 'inherit' },
  );

  // Merge .d.ts
  if (mergeTypes && pkg.types) {
    mergeBuildTypes(pkgDir, target);
  }
}

function getPrivateDeps(dotDTs) {
  const code = fs.readFileSync(dotDTs).toString();
  const deps = getDeps(code);
  return allTargets
    .map((target) => {
      const pkg = require(path.resolve(`packages/core/${target}/package.json`));
      return pkg.private
        ? deps.find((v) => {
            if (v.pkgName === pkg.name) {
              v.dirName = target;
              return v;
            }
            return null;
          })
        : null;
    })
    .filter((v) => v);
}

const mergeOpts = {
  localBuild: true,
  showVerboseMessages: true,
};

function mergePrivateTypes(
  config,
  baseRoot,
  target,
  completedPkgs,
  { dirName, pkgName },
) {
  const { Extractor } = require('@microsoft/api-extractor');
  const { publicTrimmedFilePath, mainEntryPointFilePath } = config;

  // 复用 config，打包依赖的私有包
  config.mainEntryPointFilePath = mainEntryPointFilePath.replace(
    `dist/packages/core/${target}/`,
    `dist/packages/core/${dirName}/`,
  );

  config.publicTrimmedFilePath = publicTrimmedFilePath.replace(
    `core/${baseRoot}/dist/${target}.d.ts`,
    `core/${baseRoot}/dist/${dirName}.d.ts`,
  );

  // 替换包的引用方式
  const replaceDeps = () => {
    const code = fs.readFileSync(publicTrimmedFilePath).toString();
    fs.writeFileSync(
      publicTrimmedFilePath,
      code.replace(matchPkgName(pkgName), (k1) => {
        return k1.replace(pkgName, `./${dirName}`);
      }),
    );
  };

  // 避免循环引用打包的问题
  if (completedPkgs.includes(config.publicTrimmedFilePath)) {
    replaceDeps();
    return true;
  }

  const result = Extractor.invoke(config, mergeOpts);
  if (result.succeeded) {
    completedPkgs.push(config.publicTrimmedFilePath);
    const deps = getPrivateDeps(config.publicTrimmedFilePath);

    if (deps.length > 0) {
      const done = deps.every((data) =>
        mergePrivateTypes(config, baseRoot, dirName, completedPkgs, data),
      );
      if (!done) return false;
    }
    replaceDeps();
  }
  return result.succeeded;
}

async function mergeBuildTypes(pkgDir, target) {
  console.log();
  console.log(
    chalk.bold(chalk.blue.bold(`Rolling up type definitions for ${target}...`)),
  );

  const completedPkgs = [];
  const { Extractor, ExtractorConfig } = require('@microsoft/api-extractor');
  const extractorConfigPath = path.resolve(pkgDir, 'api-extractor.json');
  const extractorConfig = ExtractorConfig.loadFileAndPrepare(
    extractorConfigPath,
  );
  const extractorResult = Extractor.invoke(extractorConfig, mergeOpts);

  if (extractorResult.succeeded) {
    completedPkgs.push(extractorConfig.publicTrimmedFilePath);
    const deps = getPrivateDeps(extractorConfig.publicTrimmedFilePath);
    if (
      !deps.length ||
      deps.every((data) =>
        mergePrivateTypes(extractorConfig, target, target, completedPkgs, data),
      )
    ) {
      // 如果当前包内有额外的全局 .d.ts，可以手动拼接到后面
      console.log(chalk.green.bold('API Extractor completed successfully.\n'));
      await fs.remove(`${pkgDir}/dist/packages`);
      await fs.remove('dist');
      await fs.remove('temp');
    }
  } else {
    console.log(
      chalk.red.bold(
        `API Extractor completed with ${extractorResult.errorCount} errors` +
          ` and ${extractorResult.warningCount} warnings`,
      ),
    );
    process.exit(1);
  }
}
