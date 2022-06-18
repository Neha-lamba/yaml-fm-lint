#! /usr/bin/env node
const {
  readFileSync,
  lstatSync,
  readdir,
  readFile,
  readdirSync,
  writeFile,
} = require("fs");
const { promisify } = require("util");
const { lint } = require("yaml-lint");
const chalk = require("chalk");
const { load, dump } = require("js-yaml");
const {
  checkAttributes,
  indentationError,
  spaceBeforeColonError,
  blankLinesError,
  quotesError,
  trailingSpacesError,
  bracketsError,
  curlyBracesError,
  repeatingSpacesWarning,
  trailingCommasError,
  warnCommasWarning,
} = require("./errors.js");

const readdirPromise = promisify(readdir);
const readFilePromise = promisify(readFile);
const writeFilePromise = promisify(writeFile);
const cwd = process.cwd().replace(/\\/g, "/");

let args;
let config;
let errorNumber = 0;
let warningNumber = 0;
let allExcludedDirs = [];

function getSnippet(lines, col, i) {
  return `${i - 1 > 0 ? `${i - 1} | ${lines[i - 1]}\n` : ""}${i} | ${
    lines[i]
  }\n${"----^".padStart(col + 3 + Math.floor(Math.log10(i)), "-")}\n${
    i + 1 < lines.length ? `${i + 1} | ${lines[i + 1]}\n` : ""
  }`;
}

/**
 * Lints the front matter of all files in a directory non-recursively.
 * @param {string} path - path to file or directory
 * @returns {Promise<string?>} - null if everything is ok, otherwise error message
 */
function lintNonRecursively(path) {
  return new Promise((resolve, reject) => {
    if (lstatSync(path).isDirectory()) {
      const files = readdirSync(path, "utf8");

      const promiseArr = [];
      for (const file of files) {
        if (file.endsWith(".md")) {
          promiseArr.push(lintFile(`${path === "." ? "" : `${path}/`}${file}`));
        }
      }

      if (!promiseArr.length) {
        console.log(`No markdown files found in ${cwd}/${path}.`);
        return resolve();
      }

      Promise.all(promiseArr).then(resolve).catch(reject);
    } else if (config.extensions.some((ext) => path.endsWith(ext))) {
      lintFile(path).then(resolve).catch(reject);
    } else {
      reject(
        `${chalk.red(
          "YAMLException:"
        )} ${path} does not have a valid extension.`
      );
    }
  });
}

/**
 * Lints the front matter of all files in a directory recursively.
 * @param {string} path - path to file or directory
 */
function lintRecursively(path) {
  return new Promise((resolve, reject) => {
    if (lstatSync(path).isDirectory()) {
      if (
        allExcludedDirs.some((ignoredDirectory) =>
          path.endsWith(ignoredDirectory)
        ) &&
        !config.includeDirs.some((includedDirectory) =>
          path.endsWith(includedDirectory)
        )
      )
        return resolve();

      readdirPromise(path, "utf8")
        .then((files) => {
          const promiseArr = [];
          for (const file of files) {
            promiseArr.push(
              lintRecursively(`${path === "." ? "" : `${path}/`}${file}`)
            );
          }

          Promise.all(promiseArr).then(resolve).catch(reject);
        })
        .catch(reject);
    } else if (config.extensions.some((ext) => path.endsWith(ext))) {
      lintFile(path).then(resolve).catch(reject);
    } else return resolve();
  });
}

/**
 * Lints the file's YAML front matter.
 * @param {string} filePath - path to file
 * @returns null if everything is ok, otherwise error message
 */
function lintFile(filePath) {
  return new Promise((resolve, reject) => {
    readFilePromise(filePath, "utf8")
      .then((data) => {
        const lines = data.replace(/\r/g, "").split("\n");
        lines.unshift("");
        const fmClosingTagIndex = lines.indexOf("---", 2);

        if (!lines[1].startsWith("---") || fmClosingTagIndex === -1) {
          console.log(
            `${(config.mandatory ? chalk.red : chalk.yellow)(
              "YAMLException:"
            )} front matter not found in ${cwd}/${filePath}. Make sure front matter is at the beginning of the file.\n`
          );
          if (config.mandatory) {
            process.exitCode = 1;
            errorNumber++;
          } else {
            warningNumber++;
          }
          return resolve();
        }

        const frontMatter = lines.slice(0, fmClosingTagIndex + 1);
        const attributes = load(
          frontMatter.filter((l) => l !== "---").join("\n")
        );

        lint(frontMatter.join("\n"))
          .then(() => {
            if (args.fix) {
              const fixedFm = dump(attributes)
                .split("\n")
                .map((line) => line.replace(/\s*,$/g, ""));
              fixedFm.unshift("", "---");
              fixedFm[fixedFm.length - 1] = "---";

              const content = lines.slice(fmClosingTagIndex + 1).join("\n");

              lintLineByLine(fixedFm, filePath);
              fixedFm.shift();

              return writeFilePromise(
                filePath,
                `${fixedFm.join("\n")}\n${content}`
              );
            } else {
              errorNumber += lintLineByLine(frontMatter, filePath);
            }
          })
          .then(resolve)
          .catch(reject);
      })
      .catch(reject);
  });
}

/**
 * Parses given string and logs errors if any.
 * @param {string} data - data to parse
 * @param {string} filePath - path to the file
 */
function lintLineByLine(fm, filePath) {
  let fileErrors = 0;
  const attributes = [];
  const spacesBeforeColon = [];
  const blankLines = [];
  const quotes = [];
  const trailingSpaces = [];
  const brackets = [];
  const curlyBraces = [];
  const indentation = [];
  const repeatingSpaces = [];
  const warnCommas = [];
  const trailingCommas = [];
  let match;

  for (let i = 1; i < fm.length - 1; i++) {
    const line = fm[i];

    if (line.match(/^"?\w+"?\s*:/g)) {
      attributes.push(line.split(":")[0].trim());
    }

    // no-empty-lines
    if (!args.fix && line.trim() === "") {
      fileErrors++;
      blankLines.push(i);
      continue;
    }

    // no-whitespace-before-colon
    const wsbcRegex = /\s+:/g;
    while (!args.fix && (match = wsbcRegex.exec(line)) !== null) {
      fileErrors++;
      const row = i;
      const col = match.index + match[0].search(/:/) + 1;
      wsbcRegex.lastIndex = col - 1;
      spacesBeforeColon.push({
        row,
        col,
        snippet: getSnippet(fm, col, i),
      });
    }

    // no-quotes
    const quoteRegex = /['"]/g;
    while (!args.fix && (match = quoteRegex.exec(line)) !== null) {
      quoteRegex.lastIndex = match.index + 1;
      fileErrors++;
      const row = i;
      const col = match.index + match[0].search(quoteRegex) + 2;
      quotes.push({
        row,
        col,
        snippet: getSnippet(fm, col, i),
      });
    }

    // no-trailing-spaces
    const trailingSpaceRegex = /\s+$/g;
    if (!args.fix && line.search(trailingSpaceRegex) !== -1) {
      fileErrors++;
      const row = i;
      const col = line.length + 1;
      trailingSpaces.push({
        row,
        col,
        snippet: getSnippet(fm, col, i),
      });
    }

    // no-brackets
    const bracketsRegex = /[\[\]]/g;
    while (!args.fix && (match = bracketsRegex.exec(line)) !== null) {
      bracketsRegex.lastIndex = match.index + 1;
      fileErrors++;
      const row = i;
      const col = match.index + match[0].search(bracketsRegex) + 2;
      brackets.push({
        row,
        col,
        snippet: getSnippet(fm, col, i),
      });
    }

    // no-curly-braces
    const curlyBraceRegex = /[\{\}]/g;
    while (!args.fix && (match = curlyBraceRegex.exec(line)) !== null) {
      curlyBraceRegex.lastIndex = match.index + 1;
      fileErrors++;
      const row = i;
      const col = match.index + match[0].search(curlyBraceRegex) + 2;
      curlyBraces.push({
        row,
        col,
        snippet: getSnippet(fm, col, i),
      });
    }

    // incorrect-indentation
    const indentationCurr = line.search(/\S/g);
    if (!args.fix && indentationCurr > 0) {
      let indentationPrev = fm[i - 1].search(/\S/g);
      indentationPrev = indentationPrev === -1 ? 0 : indentationPrev;
      if (indentationCurr - indentationPrev > 2) {
        fileErrors++;
        const row = i;
        const col = indentationCurr + 1;
        indentation.push({
          row,
          col,
          snippet: getSnippet(fm, col, i),
        });
      }
    }

    // no-repeating-spaces
    const repeatingSpaceRegex = /\w\s{2,}\w/g;
    while ((match = repeatingSpaceRegex.exec(line)) !== null) {
      repeatingSpaceRegex.lastIndex = match.index + 1;
      warningNumber++;
      const row = i;
      const col = match.index + match[0].search(/\s\w/g) + 2;
      repeatingSpaces.push({
        row,
        col,
        snippet: getSnippet(fm, col, i),
      });
    }

    // one-space-after-colon
    const spacesAfterColon = /:[ \t]{2,}\S/g;
    while (!args.fix && (match = spacesAfterColon.exec(line)) !== null) {
      spacesAfterColon.lastIndex = match.index + 1;
      warningNumber++;
      const row = i;
      const col = match.index + match[0].search(/[ \t]\S/g) + 2;
      repeatingSpaces.push({
        row,
        col,
        snippet: getSnippet(fm, col, i),
      });
    }

    // no-trailing-commas
    const trailingCommaRegex = /,\s*$/g;
    if (!args.fix && line.search(trailingCommaRegex) !== -1) {
      fileErrors++;
      const row = i;
      const col = line.length + 1;
      trailingCommas.push({
        row,
        col,
        snippet: getSnippet(fm, col, i),
      });
    }

    // warn-commas-in-front-matter
    const commaInFrontMatterRegex = /,./g;
    while ((match = commaInFrontMatterRegex.exec(line)) !== null) {
      commaInFrontMatterRegex.lastIndex = match.index + 1;
      warningNumber++;
      const row = i;
      const col = match.index + 2;
      warnCommas.push({
        row,
        col,
        snippet: getSnippet(fm, col, i),
      });
    }
  }

  if (args.q || args.quiet) return fileErrors;

  checkAttributes(attributes, config.requiredAttributes, filePath);

  if (!args.fix) {
    if (blankLines.length > 0) blankLinesError(blankLines, filePath);
    if (trailingSpaces.length > 0)
      trailingSpacesError(trailingSpaces, filePath);
    if (spacesBeforeColon.length > 0)
      spaceBeforeColonError(spacesBeforeColon, filePath);
    if (quotes.length > 0) quotesError(quotes, filePath);
    if (brackets.length > 0) bracketsError(brackets, filePath);
    if (curlyBraces.length > 0) curlyBracesError(curlyBraces, filePath);
    if (indentation.length > 0) indentationError(indentation, filePath);
    if (trailingCommas.length > 0)
      trailingCommasError(trailingCommas, filePath);
  }

  if (warnCommas.length > 0) warnCommasWarning(warnCommas, filePath);
  if (repeatingSpaces.length > 0)
    repeatingSpacesWarning(repeatingSpaces, filePath);

  return fileErrors;
}

/**
 * Retrieves arguments from the command line
 * @returns {Object} - arguments object
 */
function getArguments() {
  const args = process.argv.slice(2);
  let pathRead = false;
  const argv = args.reduce((acc, curr) => {
    let [key, value] = curr.split("=");
    if (key.startsWith("-")) {
      key = key.replace(/^-{1,2}/, "");
    } else if (!pathRead) {
      value = key;
      key = "path";
      pathRead = true;
    } else {
      console.log(
        `${chalk.red("Invalid argument:")} ${chalk.yellow(
          `\"${curr}\"`
        )}. Only one path argument is allowed.`
      );
      process.exit(9);
    }

    if (key === "path") {
      if (value.startsWith(cwd)) {
        value = value.replace(cwd, "");
      }
      value = value.replace(/\\/g, "/");
    }

    acc[key] = value === "false" ? false : value === undefined ? true : value;
    return acc;
  }, {});

  if (!pathRead) {
    console.log(
      `${chalk.red(
        "Invalid arguments:"
      )} No path argument found. Please specify a path.`
    );
    process.exit(9);
  }

  return argv;
}

function getConfig(a) {
  let config = {
    ...JSON.parse(readFileSync(`${__dirname.replace(/\\/g, "/")}/config/default.json`)),
    ...(a.config ? JSON.parse(readFileSync(a.config)) : {}),
  };
  try {
    config = {
      ...config,
      ...JSON.parse(readFileSync(`${cwd}/.yaml-fm-lint.json`)),
    };
  } catch (_) {}

  config.mandatory =
    a.m !== undefined
      ? a.m
      : a.mandatory !== undefined
      ? a.mandatory
      : config.mandatory;

  return config;
}

function main(a, c) {
  return new Promise((resolve) => {
    args = { ...a };
    config = { ...c };
    allExcludedDirs = [...config.excludeDirs, ...config.extraExcludeDirs];

    (!args.recursive && !args.r
      ? lintNonRecursively(args.path)
      : lintRecursively(args.path)
    )
      .catch((err) => {
        console.log(err);
        process.exitCode = 1;
        errorNumber++;
      })
      .finally(() => resolve({ errorNumber, warningNumber }));
  });
}

function run() {
  console.time("Linting took");

  const a = getArguments();
  const c = getConfig(a);

  main(a, c).then(({ errorNumber, warningNumber }) => {
    if (warningNumber) {
      console.log(
        chalk.yellow(
          `⚠ ${warningNumber} warning${warningNumber > 1 ? "s" : ""} found.`
        )
      );
    }
    if (!errorNumber) {
      console.log(chalk.green("✔ All parsed files have valid front matter."));
    } else {
      process.exitCode = 1;
      console.log(
        chalk.red(
          `✘ ${errorNumber} error${
            errorNumber > 1 ? "s" : ""
          } found. You can fix the error${
            errorNumber > 1 ? "s" : ""
          } with the \`--fix\` option.`
        )
      );
    }
    console.timeEnd("Linting took");
  });
}

module.exports = {
  run,
  main,
};

// Run if invoked as a CLI
if (require.main === module) run();
