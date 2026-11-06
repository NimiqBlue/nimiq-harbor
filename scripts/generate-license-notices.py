#!/usr/bin/env python3
"""Collect upstream notices from integrity-checked locked npm tarballs.

Uses only Python 3's standard library. Downloads public package archives; never
installs or executes dependency code. Run from any directory. --check verifies
that committed notices match a fresh generation without changing them.
"""
import argparse
import base64
import concurrent.futures
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile
import time
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent.parent


def fetch(entry):
    path, item = entry
    url = item['resolved']
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != 'https' or parsed.hostname != 'registry.npmjs.org' or parsed.username or parsed.password:
        raise ValueError('Non-public-registry archive rejected: ' + path)
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=90) as response:
                data = response.read(150_000_001)
            break
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)
    if len(data) > 150_000_000:
        raise ValueError('Oversized archive: ' + path)
    matched = False
    for token in item['integrity'].split():
        algorithm, digest = token.split('-', 1)
        if algorithm not in ('sha512', 'sha384', 'sha256'):
            continue
        if base64.b64encode(hashlib.new(algorithm, data).digest()).decode() == digest:
            matched = True
    if not matched:
        raise ValueError('Archive integrity mismatch: ' + path)
    notices = []
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        manifests = [m for m in archive.getmembers() if m.isfile() and m.name.count('/') == 1 and m.name.endswith('/package.json')]
        if len(manifests) != 1:
            raise ValueError('Ambiguous archive root: ' + path)
        meta = json.load(archive.extractfile(manifests[0]))
        if meta['version'] != item['version']:
            raise ValueError('Archive version mismatch: ' + path)
        for member in sorted(archive.getmembers(), key=lambda m: m.name):
            filename = Path(member.name).name
            if member.isfile() and re.match(r'^(licen[cs]e|copying|notice|copyright|third[-_]?party[-_](?:licen[cs]es?|notices?))(?:[._-].*|$)', filename, re.I):
                if member.size > 3_000_000:
                    raise ValueError('Oversized notice: ' + member.name)
                text = archive.extractfile(member).read().decode('utf-8', errors='strict')
                notices.append((member.name, text))
        if not notices:
            for member in sorted(archive.getmembers(), key=lambda m: m.name):
                if member.isfile() and re.match(r'^readme(?:\..*)?$', Path(member.name).name, re.I) and member.size < 500_000:
                    readme = archive.extractfile(member).read().decode('utf-8', errors='replace')
                    match = re.search(r'(?im)^(?:#{1,6}\s*)?licen[cs]e\s*:?\s*$', readme)
                    if match:
                        notices.append((member.name + ' (license section)', readme[match.start():]))
    license_id = meta.get('license') or item.get('license')
    if isinstance(license_id, dict):
        license_id = license_id.get('type')
    if meta['name'] == '@1inch/fusion-sdk' and not license_id:
        if any('Permission is hereby granted, free of charge' in text and '1inch' in text for _, text in notices):
            license_id = 'MIT (from upstream LICENSE; package metadata omits license)'
    if not license_id:
        raise ValueError('Manual license review required: ' + path)
    if not notices:
        declaration = {key: meta[key] for key in ('name', 'version', 'license', 'author', 'contributors', 'repository') if key in meta}
        notices.append(('package.json (upstream license/attribution declaration; no standalone notice shipped)',
                        json.dumps(declaration, indent=2, ensure_ascii=False)))
    repo = meta.get('repository', '')
    if isinstance(repo, dict):
        repo = repo.get('url', '')
    return {'path': path, 'name': meta['name'], 'version': meta['version'],
            'license': license_id, 'development': bool(item.get('dev')),
            'optional': bool(item.get('optional')), 'archive': url,
            'integrity': item['integrity'], 'repository': repo, 'notices': notices}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    lock = json.loads((ROOT / 'package-lock.json').read_text())
    entries = sorted((p, v) for p, v in lock['packages'].items() if p)
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        packages = list(pool.map(fetch, entries))
    by_name = {(p['name'], p['version']): p for p in packages}
    for package in packages:
        parent = 'esbuild' if package['name'].startswith('@esbuild/') else 'rolldown' if package['name'].startswith('@rolldown/binding-') else None
        if parent and (parent, package['version']) in by_name:
            origin = by_name[(parent, package['version'])]
            package['notices'].extend((f"same-version {parent}: {filename}", content) for filename, content in origin['notices'])
    header = ('Harbor third-party license texts and upstream notices\n'
              'Generated from the exact package-lock.json archives with integrity verification.\n'
              'Includes runtime, development, transitive and optional/platform dependencies.\n'
              'Third-party software retains its own license; Harbor MIT does not replace it.\n'
              'Archives are read only, never executed. Preserve notices in redistributions.\n\n')
    text = [header]
    table = ['# Third-party dependency notices\n\n',
             'Harbor-owned code is MIT licensed; dependencies retain their original terms.\n',
             'See THIRD_PARTY_LICENSES.txt for the upstream copyright, license and NOTICE texts.\n',
             'This inventory includes every non-root package-lock entry, including optional\n',
             'platform packages and development tools; it is not a browser bundle inventory.\n',
             'No dependency source or binary is vendored by this source export.\n',
             'When an archive supplies no standalone license file, its README license section\n',
             'or package metadata declaration is retained explicitly, not invented. Platform\n',
             'esbuild/rolldown packages additionally receive notices from their same-version\n',
             'parent package. These are upstream evidence records, not a legal certification.\n\n',
             'Regenerate with `python3 scripts/generate-license-notices.py`; verify with `--check`.\n',
             'Generation needs network access to the public npm registry, not API credentials.\n\n',
             'Lightning CSS and its platform packages are MPL-2.0, not MIT. They are unmodified\n',
             'build-tool dependencies. Their source is available from https://github.com/parcel-bundler/lightningcss\n',
             '(match the locked version). Preserve MPL terms/source availability if redistributing\n',
             'those tools or modified covered files. npm platform archives may contain binaries,\n',
             'not the preferred source form. Do not mistake archive availability for source availability.\n\n',
             'The Fusion SDK omits a license field; its actual upstream LICENSE grants MIT terms.\n',
             'No logo, font, trademark, API access or provider service rights are granted here.\n',
             'A redistributed compiled application must also preserve applicable bundled notices.\n',
             'These records do not replace a review after dependencies or distribution methods change.\n\n',
             '| Locked path | Version | License | Scope |\n',
             '| --- | --- | --- | --- |\n']
    for package in packages:
        scope = 'development' if package['development'] else 'runtime'
        if package['optional']:
            scope += ', optional'
        table.append(f"| {package['path']} | {package['version']} | {package['license']} | {scope} |\n")
        text.append('=' * 78 + '\n')
        for key in ('path', 'name', 'version', 'license', 'archive', 'integrity', 'repository'):
            text.append(f'{key}: {package[key]}\n')
        for filename, content in package['notices']:
            text.append(f'\n--- Upstream file: {filename} ---\n{content.rstrip()}\n')
        text.append('\n')
    outputs = {'THIRD_PARTY_NOTICES.md': ''.join(table), 'THIRD_PARTY_LICENSES.txt': ''.join(text)}
    for filename, content in outputs.items():
        destination = ROOT / filename
        if args.check:
            if not destination.exists() or destination.read_bytes() != content.encode('utf-8'):
                raise SystemExit('Out of date: ' + filename)
        else:
            destination.write_text(content)
    print(json.dumps({'packages': len(packages), 'upstream_notice_files': sum(len(p['notices']) for p in packages),
                      'files': list(outputs), 'mode': 'checked' if args.check else 'generated'}))


if __name__ == '__main__':
    main()
