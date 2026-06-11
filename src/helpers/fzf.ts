import chalk from 'chalk';

export function printFzfInstructions() {
    console.log(chalk.yellow('To enable a quick fzf-powered SSH launcher, add this to your shell rc:'));
    console.log('\n' + chalk.bold('~/.bashrc or ~/.zshrc') + '\n');
    const snippet = [
        's() {',
        '  local line alias userhost',
        '  run_sshya() {',
        '    stdbuf -oL sshya "$@"',
        '  }',
        "  line=$(run_sshya list --oneline --names | fzf --with-nth=1,2 --nth=1,2 --delimiter=$'\\t') || return",
        "  alias=${line%%$'\\t'*}",
        "  userhost=${line#*$'\\t'}; userhost=${userhost%%$'\\t'*}",
        "  echo \"Connecting: $alias ($userhost)\"",
        "  run_sshya connect \"$alias\"",
        '}',
    ].join('\n');
    console.log(chalk.cyan(snippet));
    console.log('\n' + chalk.green('Notes:'));
    console.log('- This expects ' + chalk.bold('fzf') + ' to be installed.');
    console.log('- After adding this to your shell rc, reload with: ' + chalk.cyan('source ~/.zshrc') + ' or ' + chalk.cyan('source ~/.bashrc'));
    console.log('- Then simply run ' + chalk.bold('s') + ' to launch the fzf interface');
    process.exit(0);
}


