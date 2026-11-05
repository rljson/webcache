// @license
// Copyright (c) rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['**/*.js', 'coverage/', 'dist/', 'node_modules/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
);
