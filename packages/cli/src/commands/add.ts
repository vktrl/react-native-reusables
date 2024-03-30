import { existsSync, promises as fs } from 'fs';
import path from 'path';
import {
  Config,
  DEFAULT_COMPONENTS,
  DEFAULT_PLATFORMS,
  DEFAULT_LIB,
  getConfig,
  rawConfigSchema,
  resolveConfigPaths,
} from '@/src/utils/get-config';
import { getPackageManager } from '@/src/utils/get-package-manager';
import { handleError } from '@/src/utils/handle-error';
import { logger } from '@/src/utils/logger';
import {
  fetchTree,
  getItemTargetPath,
  getRegistryBaseColor,
  getRegistryIndex,
  resolveTree,
} from '@/src/utils/registry';
import { transform } from '@/src/utils/transformers';
import chalk from 'chalk';
import { Command } from 'commander';
import { execa } from 'execa';
import ora, { Ora } from 'ora';
import prompts from 'prompts';
import { z } from 'zod';
import { COMPONENTS } from '../items/components';
import { Component, INVALID_COMPONENT_ERROR, getAllComponentsToWrite } from '../items';

const addOptionsSchema = z.object({
  components: z.array(z.string()).optional(),
  overwrite: z.boolean(),
  cwd: z.string(),
  path: z.string().optional(),
});

export const add = new Command()
  .name('add')
  .description('add components to your project')
  .argument('[components...]', 'the components to add')
  .option('-o, --overwrite', 'overwrite existing files.', false)
  .option(
    '-c, --cwd <cwd>',
    'the working directory. defaults to the current directory.',
    process.cwd()
  )
  .option('-p, --path <path>', 'the path to add the component to.')
  .action(async (components, opts) => {
    try {
      const options = addOptionsSchema.parse({
        components,
        ...opts,
      });

      const cwd = path.resolve(options.cwd);

      if (!existsSync(cwd)) {
        logger.error(`The path ${cwd} does not exist. Please try again.`);
        process.exit(1);
      }

      let config = await getConfig(cwd);

      if (!config) {
        config = await promptForConfig(cwd);
      }

      let selectedComponents: Array<string> = options.components ?? [];
      if (!selectedComponents?.length) {
        const { components } = await prompts({
          type: 'multiselect',
          name: 'components',
          message: 'Which components would you like to add?',
          hint: 'Space to select. A to toggle all. Enter to submit.',
          instructions: false,
          choices: COMPONENTS.filter((comp) => comp.type === 'ui').map((entry) => ({
            title: entry.name,
            value: entry.name,
            selected: false,
          })),
        });
        selectedComponents = components;
      }

      if (!selectedComponents?.length) {
        logger.warn('No components selected. Exiting.');
        process.exit(0);
      }

      const spinner = ora(`Installing components...`).start();

      let componentsToWrite: Array<Component> = [];
      try {
        componentsToWrite = getAllComponentsToWrite(selectedComponents);
      } catch (err) {
        if (err instanceof Error && err.message === INVALID_COMPONENT_ERROR) {
          logger.error(
            `Invalid component(s): ${selectedComponents
              .filter((component) => !COMPONENTS.find((entry) => entry.name === component))
              .join(', ')}`
          );
          process.exit(1);
        }
        logger.error(err);
      }

      for (const comp of componentsToWrite) {
        spinner.text = `Installing ${comp.name}...`;

        if (Array.isArray(comp.paths)) {
          await writeFiles(comp, comp.paths, config, options, spinner);
        } else {
          await writeFiles(
            comp,
            comp.paths[config.platforms === 'universal' ? 'universal' : 'native-only'],
            config,
            options,
            spinner
          );
        }

        // TODO: Install npm dependencies

        console.log(
          'NPM PACKAGES',
          comp.npmPackages[config.platforms === 'universal' ? 'universal' : 'native-only']
        );

        // const packageManager = await getPackageManager(cwd)

        // // Install dependencies.
        // if (item.dependencies?.length) {
        //   await execa(
        //     packageManager,
        //     [
        //       packageManager === "npm" ? "install" : "add",
        //       ...item.dependencies,
        //     ],
        //     {
        //       cwd,
        //     }
        //   )
        // }

        // // Install devDependencies.
        // if (item.devDependencies?.length) {
        //   await execa(
        //     packageManager,
        //     [
        //       packageManager === "npm" ? "install" : "add",
        //       "-D",
        //       ...item.devDependencies,
        //     ],
        //     {
        //       cwd,
        //     }
        //   )
        // }
      }
      spinner.succeed(`Done.`);
    } catch (error) {
      handleError(error);
    }
  });

async function writeFiles(
  comp: Component,
  paths: Array<{ from: string; to: { folder: string; file: string } }>,
  config: Config,
  options: {
    overwrite: boolean;
    cwd: string;
    components?: string[] | undefined;
    path?: string | undefined;
  },
  spinner: Ora
) {
  for (const compPath of paths) {
    const targetDir = path.join(config.resolvedPaths.components, compPath.to.folder);
    if (!existsSync(targetDir)) {
      await fs.mkdir(targetDir, { recursive: true });
    }

    if (!options.overwrite && existsSync(path.join(targetDir, compPath.to.file))) {
      spinner.stop();
      const { overwrite } = await prompts({
        type: 'confirm',
        name: 'overwrite',
        message: `File ${[compPath.to.folder, compPath.to.file].join(
          '/'
        )} already exists. Would you like to overwrite?`,
        initial: false,
      });

      if (!overwrite) {
        logger.info(
          `Skipped ${comp.name}. To overwrite, run with the ${chalk.green('--overwrite')} flag.`
        );
        continue;
      }
    }

    spinner.start(`Installing ${comp.name}...`);
    try {
      const content = await fs.readFile(path.resolve(compPath.from), 'utf8');
      await fs.writeFile(
        path.join(targetDir, compPath.to.file),
        fixImports(content, config.aliases.components, config.aliases.lib)
      );
    } catch (error) {
      handleError(error);
    }
  }
}

function fixImports(rawfile: string, componentsAlias: string, libAlias: string) {
  return rawfile
    .replace('../Icons', `${componentsAlias}/Icons`)
    .replace('./typography', `${componentsAlias}/ui/typography`)
    .replace('./text', `${componentsAlias}/ui/text`)
    .replaceAll('../../components', componentsAlias)
    .replaceAll('../../lib', libAlias)
    .replaceAll('@rnr', `${componentsAlias}/primitives`);
}

async function promptForConfig(cwd: string) {
  const highlight = (text: string) => chalk.cyan(text);

  const options = await prompts([
    {
      type: 'select',
      name: 'platforms',
      message: `Which ${highlight('platforms')} do you support?`,
      choices: [
        { title: 'Universal (Web, iOS, and Android)', value: 'universal' },
        { title: 'Native Only (iOS and Android)', value: 'native-only' },
      ],
    },
    {
      type: 'text',
      name: 'components',
      message: `Configure the import alias for ${highlight('components')}:`,
      initial: DEFAULT_COMPONENTS,
    },
    {
      type: 'text',
      name: 'lib',
      message: `Configure the import alias for ${highlight('lib')}:`,
      initial: DEFAULT_LIB,
    },
  ]);

  const config = rawConfigSchema.parse({
    platforms: options.platforms,
    aliases: {
      lib: options.lib,
      components: options.components,
    },
  });

  const { proceed } = await prompts({
    type: 'confirm',
    name: 'proceed',
    message: `Write configuration to ${highlight('components.json')}. Proceed?`,
    initial: true,
  });

  if (proceed) {
    // Write to file.
    logger.info('');
    const spinner = ora(`Writing components.json...`).start();
    const targetPath = path.resolve(cwd, 'components.json');
    await fs.writeFile(targetPath, JSON.stringify(config, null, 2), 'utf8');
    spinner.succeed();
  }

  return await resolveConfigPaths(cwd, config);
}
