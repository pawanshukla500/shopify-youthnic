import json
import sys
import re
import shutil
import os
from pathlib import Path

root = Path('.').resolve()
out_dir = root / 'graphify-out'
out_dir.mkdir(exist_ok=True)

# 1. Detect
print("=== Step 1: Detecting codebase files ===")
from graphify.detect import detect
from graphify.paths import out_path
from graphify.watch import _read_build_excludes, _read_build_gitignore

detection = detect(root, extra_excludes=_read_build_excludes(out_path()), gitignore=_read_build_gitignore(out_path()))
(out_dir / '.graphify_detect.json').write_text(json.dumps(detection, ensure_ascii=False, indent=2), encoding='utf-8')

print(f"Corpus: {detection['total_files']} files · ~{detection.get('total_words', 0):,} words")
for cat, files in detection.get('files', {}).items():
    if files:
        print(f"  {cat}: {len(files)} files")

# 2. Structural AST extraction (excluding third-party bundled compiler scripts)
print("\n=== Step 2: AST Extraction ===")
from graphify.extract import collect_files, extract

code_files = []
for f in detection.get('files', {}).get('code', []):
    p = Path(f)
    # Skip vendor scripts, bundled toolchains in .agents, dist, and huge bundles
    if any(x in str(p) for x in ['.agents', 'node_modules', 'dist', 'temp']):
        continue
    if p.is_file() and p.stat().st_size > 300 * 1024:
        continue
    code_files.extend(collect_files(p) if p.is_dir() else [p])

if code_files:
    ast_result = extract(code_files, cache_root=root, root=root)
    (out_dir / '.graphify_ast.json').write_text(json.dumps(ast_result, indent=2, ensure_ascii=False), encoding='utf-8')
    print(f"AST: {len(ast_result['nodes'])} nodes, {len(ast_result['edges'])} edges across {len(code_files)} source files")
else:
    ast_result = {'nodes': [], 'edges': [], 'input_tokens': 0, 'output_tokens': 0}
    (out_dir / '.graphify_ast.json').write_text(json.dumps(ast_result, ensure_ascii=False), encoding='utf-8')
    print("No code files found.")

# Build map of code filenames and symbols for cross-linking
code_node_map = {}
for n in ast_result['nodes']:
    src = n.get('source_file') or ''
    if src:
        fname = Path(src).name
        code_node_map.setdefault(fname, []).append(n['id'])
        code_node_map.setdefault(src.replace('\\', '/'), []).append(n['id'])

# 3. Documents & Markdown Semantic extraction
print("\n=== Step 3: Document & Markdown Processing ===")
doc_nodes = []
doc_edges = []
all_docs = list(detection.get('files', {}).get('document', []))

# Include any documentation files in docs/ and root markdown
for md_file in list(root.glob("docs/*.md")) + list(root.glob("*.md")):
    rel = str(md_file.relative_to(root)).replace('\\', '/')
    if rel not in all_docs:
        all_docs.append(str(md_file))

for doc_path_str in all_docs:
    dp = Path(doc_path_str)
    if not dp.exists() or any(x in str(dp) for x in ['node_modules', 'dist', 'temp']):
        continue
    file_rel = str(dp.relative_to(root)).replace('\\', '/')
    file_node_id = f"doc:{file_rel}"
    doc_nodes.append({
        'id': file_node_id,
        'label': dp.name,
        'type': 'document',
        'source_file': file_rel,
        '_origin': 'semantic',
    })
    try:
        content = dp.read_text(encoding='utf-8', errors='replace')
        lines = content.splitlines()
        current_heading_id = file_node_id
        for i, line in enumerate(lines):
            line_str = line.strip()
            if line_str.startswith('#'):
                title = line_str.lstrip('#').strip()
                if title:
                    safe_slug = re.sub(r'[^a-zA-Z0-9_-]', '_', title[:40])
                    heading_id = f"section:{file_rel}#{safe_slug}"
                    doc_nodes.append({
                        'id': heading_id,
                        'label': title,
                        'type': 'section',
                        'source_file': file_rel,
                        '_origin': 'semantic',
                    })
                    doc_edges.append({
                        'source': file_node_id,
                        'target': heading_id,
                        'relation': 'contains_section',
                        '_origin': 'semantic',
                    })
                    current_heading_id = heading_id
            
            # Cross link code files mentioned in documents
            for code_ref, node_ids in code_node_map.items():
                if code_ref in line_str and len(code_ref) > 4:
                    for cid in node_ids[:2]:
                        doc_edges.append({
                            'source': current_heading_id,
                            'target': cid,
                            'relation': 'references_code',
                            '_origin': 'semantic',
                        })
    except Exception as e:
        pass

semantic_result = {
    'nodes': doc_nodes,
    'edges': doc_edges,
    'hyperedges': [],
    'input_tokens': 0,
    'output_tokens': 0,
}
(out_dir / '.graphify_semantic.json').write_text(json.dumps(semantic_result, indent=2, ensure_ascii=False), encoding='utf-8')
print(f"Semantic Docs: {len(doc_nodes)} nodes, {len(doc_edges)} edges across {len(all_docs)} documents")

# 4. Merge AST + Semantic
print("\n=== Step 4: Merging AST & Semantic ===")
seen_ids = set()
merged_nodes = []
for n in ast_result['nodes']:
    n.setdefault('_origin', 'ast')
    if n['id'] not in seen_ids:
        seen_ids.add(n['id'])
        merged_nodes.append(n)

for n in doc_nodes:
    if n['id'] not in seen_ids:
        seen_ids.add(n['id'])
        merged_nodes.append(n)

merged_edges = ast_result['edges'] + doc_edges
merged_extract = {
    'nodes': merged_nodes,
    'edges': merged_edges,
    'hyperedges': [],
    'input_tokens': 0,
    'output_tokens': 0,
}
(out_dir / '.graphify_extract.json').write_text(json.dumps(merged_extract, indent=2, ensure_ascii=False), encoding='utf-8')
print(f"Merged Total: {len(merged_nodes)} nodes, {len(merged_edges)} edges")

# 5. Build NetworkX graph & Community Clustering
print("\n=== Step 5: Clustering & Community Detection ===")
from graphify.build import build_from_json
from graphify.cluster import cluster, score_all
from graphify.analyze import god_nodes, surprising_connections, suggest_questions
from graphify.report import generate
from graphify.export import to_json

G = build_from_json(merged_extract, root=str(root), directed=False)
communities = cluster(G)
cohesion = score_all(G, communities)
tokens = {'input': 0, 'output': 0}
gods = god_nodes(G)
surprises = surprising_connections(G, communities)

# Generate intelligent community labels based on prominent nodes
labels = {}
for cid, member_ids in communities.items():
    sub_labels = [G.nodes[nid].get('label', nid) for nid in member_ids if nid in G.nodes][:5]
    name = " / ".join(sub_labels[:2]) if sub_labels else f"Community {cid}"
    if len(name) > 50:
        name = name[:47] + "..."
    labels[cid] = name

questions = suggest_questions(G, communities, labels)
wrote = to_json(G, communities, str(out_dir / 'graph.json'), community_labels=labels, force=True)
report = generate(G, communities, cohesion, labels, gods, surprises, detection, tokens, str(root), suggested_questions=questions)
(out_dir / 'GRAPH_REPORT.md').write_text(report, encoding='utf-8')
(out_dir / '.graphify_labels.json').write_text(json.dumps({str(k): v for k, v in labels.items()}, ensure_ascii=False), encoding='utf-8')

print(f"Graph Built: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges across {len(communities)} communities.")

# 6. Diagnostics
print("\n=== Step 6: Graph Health Diagnostic ===")
from graphify.diagnostics import diagnose_extraction, format_diagnostic_report
diag = diagnose_extraction(merged_extract, directed=False, root=str(root))
print(format_diagnostic_report(diag))

# 7. Exports: Interactive HTML
print("\n=== Step 7: Generating Interactive HTML ===")
try:
    from graphify.export import to_html
    to_html(G, communities, str(out_dir / 'graph.html'), community_labels=labels)
    print("graph.html generated successfully.")
except Exception as e:
    print(f"HTML export note: {e}")

# 8. Export Wiki: Clean directory first to avoid Windows os.replace lock issues
print("\n=== Step 8: Generating Wiki ===")
wiki_dir = out_dir / 'wiki'
if wiki_dir.exists():
    try:
        shutil.rmtree(wiki_dir)
    except Exception as e:
        print(f"Wiki clean notice: {e}")
wiki_dir.mkdir(parents=True, exist_ok=True)

try:
    from graphify.wiki import to_wiki
    count = to_wiki(G, communities, str(wiki_dir), community_labels=labels, cohesion=cohesion, god_nodes_data=gods)
    print(f"Wiki generated: {count} articles in {wiki_dir}")
except Exception as e:
    print(f"Wiki export note: {e}")

print("\nDone! Knowledge graph and wiki refreshed successfully.")
