#!/usr/bin/env python3
"""Read-only contrast checks for Session Bay's declared workbench token pairs."""
from pathlib import Path
import re

css = (Path(__file__).resolve().parent.parent / 'src/workbench.css').read_text(encoding='utf-8')

def luminance(color):
    channels = [int(color[index:index + 2], 16) / 255 for index in (1, 3, 5)]
    linear = [part / 12.92 if part <= .04045 else ((part + .055) / 1.055) ** 2.4 for part in channels]
    return sum(part * factor for part, factor in zip(linear, (.2126, .7152, .0722)))

def contrast(left, right):
    low, high = sorted((luminance(left), luminance(right)))
    return (high + .05) / (low + .05)

checks = 0
for theme, selector in [('dark', ':root'), ('light', "[data-theme='light']")]:
    match = re.search(re.escape(selector) + r'\s*\{([^}]+)\}', css)
    assert match, f'Missing {theme} token block'
    tokens = dict(re.findall(r'(--[\w-]+):\s*(#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?)(?:\s*;)', match.group(1)))
    tokens = {key: value if len(value) == 7 else '#' + ''.join(character * 2 for character in value[1:]) for key, value in tokens.items()}
    for foreground in ['--text', '--muted', '--subtle']:
        for background in ['--bg', '--panel', '--surface', '--accent-bg']:
            ratio = contrast(tokens[foreground], tokens[background])
            assert ratio >= 4.5, f'{theme}: {foreground}/{background} is only {ratio:.2f}:1'
            checks += 1
    for background in ['--bg', '--panel', '--accent-bg']:
        ratio = contrast(tokens['--accent'], tokens[background])
        assert ratio >= 4.5, f'{theme}: accent/{background} is only {ratio:.2f}:1'
        checks += 1
    for background in ['--accent', '--accent-strong']:
        ratio = contrast(tokens['--on-accent'], tokens[background])
        assert ratio >= 4.5, f'{theme}: button label/{background} is only {ratio:.2f}:1'
        checks += 1
    for background in ['--bg', '--panel', '--surface']:
        ratio = contrast(tokens['--control-border'], tokens[background])
        assert ratio >= 3, f'{theme}: control border/{background} is only {ratio:.2f}:1'
        checks += 1
    for index in range(8):
        color = tokens[f'--project-{index}']
        ratio = contrast(tokens['--on-project'], color)
        assert ratio >= 4.5, f'{theme}: project initials/--project-{index} is only {ratio:.2f}:1'
        checks += 1
        for background in ['--bg', '--panel', '--surface']:
            ratio = contrast(color, tokens[background])
            assert ratio >= 3, f'{theme}: --project-{index}/{background} is only {ratio:.2f}:1'
            checks += 1
    for foreground in ['--danger', '--warning']:
        ratio = contrast(tokens[foreground], tokens['--panel'])
        assert ratio >= 4.5, f'{theme}: {foreground}/panel is only {ratio:.2f}:1'
        checks += 1
print(f'{checks} declared semantic contrast pairs passed (normal text >=4.5:1, control boundaries >=3:1).')
print('This static token check does not replace painted-pixel, font-size, focus, or native WebView review.')
