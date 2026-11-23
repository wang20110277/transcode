#!/usr/bin/env node
import { runCli } from '../src/cli.ts';

await runCli(process.argv.slice(2));
