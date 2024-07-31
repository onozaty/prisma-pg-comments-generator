/**
 * This code is based on the following code by @Jyrno42
 * https://github.com/prisma/prisma/issues/8703#issuecomment-1614360386
 *
 * This is a workaround to have https://github.com/prisma/prisma/issues/8703 before it is implemented
 * in Prisma itself.
 */

import { createHash } from "crypto";
import { promises as fs } from "fs";

import {
  EnvValue,
  GeneratorOptions,
  generatorHandler,
} from "@prisma/generator-helper";
import { parseEnvValue } from "@prisma/internals";
import { Model, parse } from "./parser";

const generateModelComment = (model: Model): string[] => {
  const commentStatements: string[] = [];

  if (model.documentation) {
    // ON TABLE
    commentStatements.push(
      `COMMENT ON TABLE "${model.dbName}" IS '${escapeComment(model.documentation)}';`,
    );
  }

  for (const field of model.fields) {
    if (field.documentation) {
      // ON COLUMN
      commentStatements.push(
        `COMMENT ON COLUMN "${model.dbName}"."${field.dbName}" IS '${escapeComment(field.documentation)}';`,
      );
    }
  }

  return [`-- ${model.dbName} comments`, ...commentStatements, ""];
};

const escapeComment = (comment: string) => {
  return comment.replace(/'/g, "''");
};

const fileHash = async (file: string, allowEmpty = false): Promise<string> => {
  try {
    const fileContent = await fs.readFile(file, "utf-8");

    // now use sha256 to hash the content and return it
    return createHash("sha256").update(fileContent).digest("hex");
  } catch (e: any) {
    if (e.code === "ENOENT" && allowEmpty) {
      return "";
    }

    throw e;
  }
};

const lockChanged = async (
  lockFile: string,
  tmpLockFile: string,
): Promise<boolean> => {
  return (await fileHash(lockFile, true)) !== (await fileHash(tmpLockFile));
};

const generate = async (options: GeneratorOptions) => {
  const outputDir = parseEnvValue(options.generator.output as EnvValue);
  await fs.mkdir(outputDir, { recursive: true });

  const models = parse(options.dmmf.datamodel);
  const allStatements = models.map((x) => generateModelComment(x)).flat();

  const tmpLock = await fs.open(`${outputDir}/.comments-lock.tmp`, "w+");

  await tmpLock.write("-- generator-version: 1.0.0\n\n");

  // concat all promises and separate with new line and two newlines between each model
  const allStatementsString = allStatements.join("\n");

  await tmpLock.write(allStatementsString);
  await tmpLock.close();

  // compare hashes of tmp lock file and existing lock file
  // if they are the same, do nothing
  // if they are different, write tmp lock file to lock file
  // if lock file does not exist, also write tmp lock file to lock file
  const isChanged = await lockChanged(
    `${outputDir}/.comments-lock`,
    `${outputDir}/.comments-lock.tmp`,
  );

  if (isChanged) {
    await fs.copyFile(
      `${outputDir}/.comments-lock.tmp`,
      `${outputDir}/.comments-lock`,
    );

    // when lockfile changed we generate a new migration file too
    const date = new Date();
    date.setMilliseconds(0);

    const dateStr = date
      .toISOString()
      .replace(/[:\-TZ]/g, "")
      .replace(".000", "");
    const migrationDir = `prisma/migrations/${dateStr}_update_comments`;

    console.log(
      `Lock file changed, creating a new migration at ${migrationDir}...`,
    );

    await fs.mkdir(migrationDir, { recursive: true });

    await fs.copyFile(
      `${outputDir}/.comments-lock`,
      `${migrationDir}/migration.sql`,
    );
  } else {
    console.log(
      "No changes detected, skipping creating a fresh comment migration...",
    );
  }

  // always delete tmp lock file
  await fs.unlink(`${outputDir}/.comments-lock.tmp`);

  console.log("Comment generation completed");
};

generatorHandler({
  onManifest() {
    return {
      defaultOutput: "comments",
      prettyName: "Prisma Database comments Generator",
    };
  },
  onGenerate: generate,
});
