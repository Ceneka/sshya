import chalk from 'chalk';

export function printFzfInstructions() {
    console.log(chalk.yellow('To enable a quick fzf-powered SSH launcher, add this to your shell rc:'));
    console.log('\n' + chalk.bold('~/.bashrc or ~/.zshrc') + '\n');
    const snippet = [
        '_fzf_sshya() {',
        '  local line alias userhost command oldstty',
        '  # Temporarily disable XON/XOFF so Ctrl-S works, then restore',
        '  oldstty=$(stty -g 2>/dev/null)',
        '  stty -ixon 2>/dev/null || true',
        '  run_sshya() {',
        '    if command -v sshya >/dev/null 2>&1; then',
        '      stdbuf -oL sshya "$@"',
        '    else',
        '      stdbuf -oL bun --silent run start "$@"',
        '    fi',
        '  }',
        "  line=$(run_sshya list --oneline --names | fzf --tac --with-nth=1,2 --delimiter=$'\\t') || { stty \"$oldstty\" 2>/dev/null || true; return; }",
        "  alias=${line%%$'\\t'*}",
        "  userhost=${line#*$'\\t'}; userhost=${userhost%%$'\\t'*}",
        "  command=$(run_sshya print \"$alias\")",
        "  echo \"Connecting: $alias ($userhost)\"",
        "  # Ensure ZLE releases the terminal before starting interactive ssh",
        "  if [ -n \"$ZSH_VERSION\" ]; then",
        "    local -a _args",
        "    local remote_cmd=\"\"",
        "    # Check if command contains -t for remote command",
        "    if [[ \"$command\" == *' -t '* ]]; then",
        "      # Split at -t, parse only SSH args, keep remote command as-is",
        "      _args=(${(zQ)command%% -t *})",
        "      remote_cmd=\"${command#* -t }\"",
        "      ssh \"${_args[@]}\" -t \"$remote_cmd\"",
        "    else",
        "      _args=(${(zQ)command})",
        "      ssh \"${_args[@]}\"",
        "    fi",
        "    zle -R -c",
        "  else",
        "    read -r -a __args <<< \"$command\"",
        "    ssh \"${__args[@]}\"",
        "  fi",
        "  stty \"$oldstty\" 2>/dev/null || true",
        '}',
        '# zsh widget binding (recommended):',
        'zle -N _fzf_sshya',
        "bindkey '^S' _fzf_sshya",
    ].join('\n');
    console.log(chalk.cyan(snippet));
    console.log('\n' + chalk.green('Notes:'));
    console.log('- This expects ' + chalk.bold('fzf') + ' to be installed.');
    console.log('- On bash, you can bind with: ' + chalk.cyan("bind -x '" + '\\"\\u0013\\":_fzf_sshya' + "'"));
    console.log('- If Ctrl-S is flow control, disable with: ' + chalk.cyan('stty -ixon'));
    process.exit(0);
}


