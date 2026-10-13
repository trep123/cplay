#!/bin/sh
# Concatenate the interpreter sources into the single-file ../../mlinterp.js
cd "$(dirname "$0")"
cat 01_core.js 02_parse.js 03_ops.js 04_index.js 05_interp.js 06_calls.js 07_display.js \
    08_builtins_core.js 09_linalg.js 10_strings.js 11_misc.js 12_plot.js 13_run.js > ../../mlinterp.js
node -e "require('../../mlinterp.js')" && echo "built mlinterp.js"
