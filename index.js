#! /usr/bin/env node
const { readFileSync, lstatSync, readdirSync, writeFileSync } = require("fs");
const chalk = require("chalk");
const { load, dump } = require("js-yaml");
const { showOneline, showError, showWarning } = require("./errors.js");

const cwd = process.cwd().replace(/\\/g, "/");

let args;
let config;
let errorNumber = 0;
let fixableErrors = 0;
let warningNumber = 0;
let allExcludedDirs = [];

function getSnippet(lines, col, row) {
  return `${row - 1} | ${lines[row - 1]}\n${row} | ${
    lines[row]
  }\n${"----^".padStart(col + 3 + Math.floor(Math.log10(row)), "-")}\n${
    row + 1
  } | ${lines[row + 1]}\n`;
}

/**
 * Lints the front matter of all files in a directory non-recursively.
 * @param {string} path - path to file or directory
 * @returns {Promise<string?>} - null if everything is ok, otherwise error message
 */
function lintNonRecursively(path) {
  return new Promise((resolve, reject) => {
    if (lstatSync(path).isDirectory()) {
      try {
        const files = readdirSync(path, "utf8");

        const promiseArr = [];
        for (const file of files) {
          if (config.extensions.some((ext) => file.endsWith(ext))) {
            promiseArr.push(
              lintFile(`${path === "." ? "" : `${path}/`}${file}`)
            );
          }
        }

        if (!promiseArr.length) {
          console.log(`No markdown files found in ${cwd}/${path}.`);
          return resolve();
        }

        Promise.all(promiseArr).then(resolve).catch(reject);
      } catch (error) {
        reject(error);
      }
    } else if (config.extensions.some((ext) => path.endsWith(ext))) {
      lintFile(path).then(resolve).catch(reject);
    } else {
      reject(
        `${
          args.colored ? chalk.red("YAMLException:") : "YAMLException:"
        } ${path} does not have a valid extension.`
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

      try {
        const files = readdirSync(path, "utf8");
        const promiseArr = [];
        for (const file of files) {
          promiseArr.push(
            lintRecursively(`${path === "." ? "" : `${path}/`}${file}`)
          );
        }

        Promise.all(promiseArr).then(resolve).catch(reject);
      } catch (error) {
        reject(error);
      }
    } else if (config.extensions.some((ext) => path.endsWith(ext))) {
      lintFile(path).then(resolve).catch(reject);
    } else return resolve();
  });
}

/**
 * Lints the file's YAML front matter.
 * @param {string} filePath - path to file
 * @returns {Promise<{filePath: string, fileErrors: number, fileWarnings: number, errors: { noFrontMatter: true } | { customError: {row: number, col: number, message: string} } | {[message: string]: {row: number, col?: number, colStart?: number, colEnd?: number, snippet?: string}}, warnings: {} | {[message: string]: {row: number, col?: number, colStart?: number, colEnd?: number, snippet?: string}}}>}
 */
function lintFile(filePath, text = "", a = {}, c = {}) {
  return new Promise(async (resolve, reject) => {
    try {
      let data = "";

      if (text) {
        data = text;
        args = { ...a };
        config = { ...c };
      } else {
        data = readFileSync(filePath, "utf8");
      }

      const lines = data.replace(/\r/g, "").split("\n");
      lines.unshift("");
      const fmClosingTagIndex = lines.indexOf("---", 2);

      if (!lines[1].startsWith("---") || fmClosingTagIndex === -1) {
        if (!args.quiet) {
          (config.mandatory ? showError : showWarning)(
            "front matter not found",
            filePath,
            "Make sure front matter is at the beginning of the file.",
            args,
            true
          );
        }

        if (config.mandatory) {
          process.exitCode = 1;
          errorNumber++;
        } else {
          warningNumber++;
        }

        return resolve({
          filePath,
          fileErrors: errorNumber,
          fileWarnings: warningNumber,
          errors: { noFrontMatter: true },
          warnings: {},
        });
      }

      let fmLines = lines.slice(0, fmClosingTagIndex + 1);

      try {
        const attributes = load(fmLines.filter((l) => l !== "---").join("\n"));
        let basic, extra;

        if (args.fix) {
          const fixedFm = dump(attributes)
            .split("\n")
            .map((line) => line.replace(/\s*,$/g, ""));
          fixedFm[fixedFm.unshift("", "---") - 1] = "---";
          const content = lines.slice(fmClosingTagIndex + 1).join("\n");
          writeFileSync(filePath, `${fixedFm.slice(1).join("\n")}\n${content}`);
          fmLines = fixedFm;
        }

        basic = lintLineByLine(fmLines, filePath);
        extra = extraLinters(attributes, fmLines, filePath);
        errorNumber += basic.fileErrors + extra.fileErrors;
        warningNumber += basic.fileWarnings + extra.fileWarnings;

        resolve({
          filePath,
          fileErrors: errorNumber,
          fileWarnings: warningNumber,
          errors: {
            ...basic.errors,
            ...extra.extraErrors,
          },
          warnings: {
            ...basic.warnings,
            ...extra.extraWarnings,
          },
        });
      } catch (error) {
        if (text) console.log("ERROR: ", error);

        errorNumber++;

        const row = error.mark ? error.mark.line + 1 : undefined;
        const col = error.mark ? error.mark.column + 1 : undefined;

        if (!args.quiet) {
          showError(
            error.reason,
            filePath,
            [{ row, col, snippet: getSnippet(fmLines, col, row) }],
            args
          );
        }

        resolve({
          filePath,
          fileErrors: errorNumber,
          fileWarnings: warningNumber,
          errors: {
            customError: {
              message: error.reason,
              row,
              col,
            },
          },
          warnings: {},
        });
      }
    } catch (error) {
      reject(error);
    }
  });
}

function extraLinters(attributes, fmLines, filePath) {
  let extraErrors = {};
  let extraWarnings = {};
  let fileErrors = 0;
  let fileWarnings = 0;

  if (!config.extraLintFns)
    return { extraErrors, extraWarnings, fileErrors, fileWarnings };

  config.extraLintFns.forEach((linter) => {
    const { errors, warnings } = linter({
      attributes,
      fmLines,
      showOneline: (type, message, affected) => {
        if (affected && !affected.row && !affected.snippet) return;

        const logAffected = !affected
          ? undefined
          : affected.col
          ? [affected]
          : affected.row
          ? affected.row
          : affected.snippet;

        showOneline(type, message, filePath, logAffected, args);

        const extensionAffected = affected?.row ? affected : { row: 0, col: 3 };

        if (type === "Error") {
          extraErrors = {
            ...extraErrors,
            [message]: [
              ...(!extraErrors[message] ? [] : extraErrors[message]),
              extensionAffected,
            ],
          };
        } else {
          extraWarnings = {
            ...extraWarnings,
            [message]: [
              ...(!extraWarnings[message] ? [] : extraWarnings[message]),
              extensionAffected,
            ],
          };
        }
      },
    });
    fileErrors += errors;
    fileWarnings += warnings;
  });

  return { extraErrors, extraWarnings, fileErrors, fileWarnings };
}

/**
 * Parses given string and logs errors if any.
 * @param {string} data - data to parse
 * @param {string} filePath - path to the file
 */
function lintLineByLine(fm, filePath) {
  let fileErrors = 0;
  let fileWarnings = 0;
  let match;

  const basicErrors = {
    "missing required attribute": [...config.requiredAttributes],
    "there must be no whitespace before colons": [],
    "there must be no empty lines": [],
    "there must be no quotes in the front matter": [],
    "there must be no trailing spaces": [],
    "there must be no brackets": [],
    "there must be no curly braces": [],
    "lines cannot be indented more than 2 spaces from the previous line": [],
    "there must be no trailing commas": [],
  };

  const basicWarnings = {
    "possibly unintended whitespace": [],
    "possibly unintended commas": [],
  };

  const oneLineErrors = [
    "there must be no empty lines",
    "missing required attribute",
  ];

  for (let i = 1; i < fm.length - 1; i++) {
    const line = `${fm[i]}`;

    // attributes
    if (line.match(/^"?\w+"?\s*:/g)) {
      const atr = line.split(":")[0].trim();
      const atrIndex = basicErrors["missing required attribute"].indexOf(atr);
      if (atrIndex > -1) {
        basicErrors["missing required attribute"].splice(atrIndex, 1);
      }
    }

    // no-empty-lines
    if (!args.fix && line.trim() === "") {
      fileErrors++;
      fixableErrors++;
      basicErrors["there must be no empty lines"].push(i);
      continue;
    }

    // no-whitespace-before-colon
    const wsbcRegex = /(\s+):/g;
    while (!args.fix && (match = wsbcRegex.exec(line)) !== null) {
      const wsbcLength = match[1].length + 1;
      fileErrors++;
      fixableErrors++;
      const row = i;
      const col = match.index + match[0].search(/:/) + 1;
      wsbcRegex.lastIndex = col - 1;
      basicErrors["there must be no whitespace before colons"].push({
        row,
        col,
        colStart: col - wsbcLength,
        colEnd: col - 1,
        snippet: getSnippet(fm, col, row),
      });
    }

    // no-quotes
    const quoteRegex = /['"]/g;
    while (!args.fix && (match = quoteRegex.exec(line)) !== null) {
      quoteRegex.lastIndex = match.index + 1;
      fileErrors++;
      fixableErrors++;
      const row = i;
      const col = match.index + match[0].search(quoteRegex) + 2;
      basicErrors["there must be no quotes in the front matter"].push({
        row,
        col,
        snippet: getSnippet(fm, col, i),
      });
    }

    // no-trailing-spaces
    const trailingSpaceRegex = /(\s+)$/g;
    if (!args.fix && line.search(trailingSpaceRegex) !== -1) {
      const spaceCount = trailingSpaceRegex.exec(line)[0].length + 1;
      fileErrors++;
      fixableErrors++;
      const row = i;
      const col = line.length + 1;
      basicErrors["there must be no trailing spaces"].push({
        row,
        col,
        colStart: col - spaceCount,
        colEnd: col,
        snippet: getSnippet(fm, col, row),
      });
    }

    // no-brackets
    const bracketsRegex = /[\[\]]/g;
    while (!args.fix && (match = bracketsRegex.exec(line)) !== null) {
      bracketsRegex.lastIndex = match.index + 1;
      fileErrors++;
      fixableErrors++;
      const row = i;
      const col = match.index + match[0].search(bracketsRegex) + 2;
      basicErrors["there must be no brackets"].push({
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
      fixableErrors++;
      const row = i;
      const col = match.index + match[0].search(curlyBraceRegex) + 2;
      basicErrors["there must be no curly braces"].push({
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
        fixableErrors++;
        const row = i;
        const col = indentationCurr + 1;
        basicErrors[
          "lines cannot be indented more than 2 spaces from the previous line"
        ].push({
          row,
          col,
          colStart: 0,
          colEnd: col - 1,
          snippet: getSnippet(fm, col, i),
        });
      }
    }

    // no-repeating-spaces
    const repeatingSpaceRegex = /\w(\s{2,})\w/g;
    while ((match = repeatingSpaceRegex.exec(line)) !== null) {
      const spaceCount = match[1].length + 1;
      repeatingSpaceRegex.lastIndex = match.index + 1;
      fileWarnings++;
      const row = i;
      const col = match.index + match[0].search(/\s\w/g) + 2;
      basicWarnings["possibly unintended whitespace"].push({
        row,
        col,
        colStart: col - spaceCount,
        colEnd: col - 1,
        snippet: getSnippet(fm, col, i),
      });
    }

    // one-space-after-colon
    const spacesAfterColon = /:([ \t]{2,})\S/g;
    while (!args.fix && (match = spacesAfterColon.exec(line)) !== null) {
      const spaceCount = match[1].length + 1;
      spacesAfterColon.lastIndex = match.index + 1;
      fileWarnings++;
      const row = i;
      const col = match.index + match[0].search(/[ \t]\S/g) + 2;
      basicWarnings["possibly unintended whitespace"].push({
        row,
        col,
        colStart: col - spaceCount,
        colEnd: col - 1,
        snippet: getSnippet(fm, col, i),
      });
    }

    // no-trailing-commas
    const trailingCommaRegex = /,\s*$/g;
    if (!args.fix && line.search(trailingCommaRegex) !== -1) {
      fileErrors++;
      fixableErrors++;
      const row = i;
      const col = line.length + 1;
      basicErrors["there must be no trailing commas"].push({
        row,
        col,
        snippet: getSnippet(fm, col, i),
      });
    }

    // warn-commas-in-front-matter
    const commaInFrontMatterRegex = /,./g;
    while ((match = commaInFrontMatterRegex.exec(line)) !== null) {
      commaInFrontMatterRegex.lastIndex = match.index + 1;
      fileWarnings++;
      const row = i;
      const col = match.index + 2;
      basicWarnings["possibly unintended commas"].push({
        row,
        col,
        snippet: getSnippet(fm, col, i),
      });
    }
  }

  fileErrors += basicErrors["missing required attribute"].length;

  if (!args.quiet) {
    Object.keys(basicErrors).forEach((message) => {
      if (basicErrors[message].length > 0) {
        showError(
          message,
          filePath,
          basicErrors[message],
          args,
          oneLineErrors.includes(message)
        );
      }
    });

    Object.keys(basicWarnings).forEach((message) => {
      if (basicWarnings[message].length > 0) {
        showWarning(message, filePath, basicWarnings[message], args);
      }
    });
  }

  return {
    filePath,
    fileErrors,
    fileWarnings,
    errors: basicErrors,
    warnings: basicWarnings,
  };
}

/**
 * Retrieves arguments from the command line
 * @returns {{path: string, fix: boolean, config: string, recursive: boolean, mandatory: boolean, quiet: boolean, oneline: boolean, colored: boolean}} - arguments object
 */
function getArguments() {
  let pathRead = false;
  const argv = process.argv.slice(2).reduce((acc, curr) => {
    let [key, value] = curr.split("=");
    if (key.startsWith("-")) {
      key = key.replace(/^-{1,2}/, "");
    } else if (!pathRead) {
      value = key;
      key = "path";
      pathRead = true;
    } else {
      value = key;
      key = "path";
      console.log(
        `${chalk.red("Invalid argument:")} ${chalk.yellow(
          `\"${curr}\"`
        )}. Only one path argument is allowed.`
      );
      process.exitCode = 9;
    }

    if (key === "path") {
      if (value.startsWith(cwd)) {
        value = value.replace(`${cwd}/`, "");
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
    process.exitCode = 9;
  }

  return {
    path: argv.path,
    fix: argv.fix !== undefined ? argv.fix : false,
    config: argv.config,
    recursive:
      argv.recursive !== undefined
        ? argv.recursive
        : argv.r !== undefined
        ? argv.r
        : false,
    mandatory:
      argv.mandatory !== undefined
        ? argv.mandatory
        : argv.m !== undefined
        ? argv.m
        : true,
    quiet:
      argv.quiet !== undefined
        ? argv.quiet
        : argv.q !== undefined
        ? argv.q
        : false,
    oneline:
      argv.oneline !== undefined
        ? argv.oneline
        : argv.o !== undefined
        ? argv.o
        : false,
    colored:
      argv.colored !== undefined
        ? argv.colored
        : argv.c !== undefined
        ? argv.c
        : true,
  };
}

function getConfig(a) {
  let config = {
    ...JSON.parse(
      readFileSync(`${__dirname.replace(/\\/g, "/")}/config/default.json`)
    ),
  };
  try {
    const configJs = require(`${cwd}/.yaml-fm-lint.js`);
    config = {
      ...config,
      ...configJs,
    };
  } catch (_) {
    try {
      config = {
        ...config,
        ...JSON.parse(readFileSync(`${cwd}/.yaml-fm-lint.json`)),
      };
    } catch (_) {}
  }

  config = {
    ...config,
    ...(!a.config
      ? {}
      : a.config.endsWith(".js")
      ? require(`${cwd}/${a.config}`)
      : JSON.parse(readFileSync(a.config))),
  };

  config.mandatory = a.mandatory !== undefined ? a.mandatory : config.mandatory;

  return config;
}

function main(a, c) {
  return new Promise((resolve) => {
    args = { ...a };
    config = { ...c };
    allExcludedDirs = [...config.excludeDirs, ...config.extraExcludeDirs];

    (!args.recursive
      ? lintNonRecursively(args.path)
      : lintRecursively(args.path)
    )
      .then((errors) => resolve({ errors, errorNumber, warningNumber }))
      .catch((err) => {
        console.log(err);
        process.exitCode = 1;
        errorNumber++;
        resolve({ errorNumber, warningNumber });
      });
  });
}

function run() {
  return new Promise((resolve) => {
    console.time("Linting took");

    const a = getArguments();

    if (process.exitCode) {
      console.timeEnd("Linting took");
      return resolve({ errorNumber, warningNumber, args, config });
    }

    const c = getConfig(a);

    main(a, c)
      .then(({ errorNumber, warningNumber }) => {
        if (warningNumber) {
          console.log(
            args.colored
              ? chalk.yellow(
                  `⚠ ${warningNumber} warning${
                    warningNumber > 1 ? "s" : ""
                  } found.`
                )
              : `⚠ ${warningNumber} warning${
                  warningNumber > 1 ? "s" : ""
                } found.`
          );
        }
        if (errorNumber) {
          process.exitCode = 1;
          console.log(
            args.colored
              ? chalk.red(
                  `✘ ${errorNumber} error${
                    errorNumber === 1 ? "" : "s"
                  } found.${
                    fixableErrors > 0
                      ? ` ${fixableErrors} error${
                          fixableErrors === 1 ? "" : "s"
                        } fixable with the \`--fix\` option.`
                      : ""
                  }`
                )
              : `✘ ${errorNumber} error${errorNumber === 1 ? "" : "s"} found.${
                  fixableErrors > 0
                    ? ` ${fixableErrors} error${
                        fixableErrors === 1 ? "" : "s"
                      } fixable with the \`--fix\` option.`
                    : ""
                }`
          );
        } else if (!warningNumber) {
          console.log(
            args.colored
              ? chalk.green("✔ All parsed files have valid front matter.")
              : "✔ All parsed files have valid front matter."
          );
        }
        console.timeEnd("Linting took");
        return { errorNumber, warningNumber, args, config };
      })
      .then(resolve);
  });
}

module.exports = {
  run,
  main,
  lintFile,
};

// Run if invoked as a CLI
if (require.main === module) run();
