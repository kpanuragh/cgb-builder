/**
 * PHP language adapter.
 *
 * Extracts:
 *  - use statements (namespace imports)  → imports edges
 *  - namespace declarations              → stored as metadata
 *  - class definitions                   → class nodes + inherits / implements edges
 *  - interface definitions               → interface nodes
 *  - trait definitions                    → class nodes (meta: isTrait)
 *  - function definitions                → function nodes
 *  - method declarations                 → method nodes
 */

import * as path from 'path';
import type Parser from 'web-tree-sitter';
import { treeSitterEngine } from '../tree-sitter-engine.js';
import type { LanguageAdapter } from '../adapter.js';
import { makeNodeId, makeEdgeId, fileDisplayName, truncate } from '../utils.js';
import type { GraphEdge, GraphNode, ParsedFile } from '../../types.js';

export class PhpAdapter implements LanguageAdapter {
  readonly language = 'php' as const;

  async parse(filePath: string, source: string): Promise<ParsedFile> {
    const tree = await treeSitterEngine.parse(source, 'php');

    const nodes: Omit<GraphNode, 'updatedAt'>[] = [];
    const edges: Omit<GraphEdge, 'updatedAt'>[] = [];

    const fileNodeId = makeNodeId('file', filePath);
    const namespace = this.extractNamespace(tree.rootNode);

    nodes.push({
      id: fileNodeId,
      kind: 'file',
      name: fileDisplayName(filePath),
      filePath,
      description: `PHP source file: ${path.basename(filePath)}`,
      isExternal: false,
      language: 'php',
      meta: JSON.stringify(namespace ? { namespace } : {}),
    });

    this.extractUseStatements(tree.rootNode, fileNodeId, nodes, edges);
    this.extractClasses(tree.rootNode, filePath, fileNodeId, nodes, edges, source);
    this.extractInterfaces(tree.rootNode, filePath, fileNodeId, nodes, edges);
    this.extractTraits(tree.rootNode, filePath, fileNodeId, nodes, edges, source);
    this.extractFunctions(tree.rootNode, filePath, fileNodeId, nodes, edges);

    return { filePath, language: 'php', nodes, edges };
  }

  private extractNamespace(root: Parser.SyntaxNode): string | null {
    for (const node of this.findByType(root, 'namespace_definition')) {
      const nameNode = node.namedChildren.find((c) => c.type === 'namespace_name');
      if (nameNode) return nameNode.text;
    }
    return null;
  }

  private extractUseStatements(
    root: Parser.SyntaxNode,
    fileNodeId: string,
    nodes: Omit<GraphNode, 'updatedAt'>[],
    edges: Omit<GraphEdge, 'updatedAt'>[],
  ): void {
    const seen = new Set<string>();
    for (const node of this.findByType(root, 'namespace_use_declaration')) {
      for (const clause of this.findByType(node, 'namespace_use_clause')) {
        const qualifiedName = clause.namedChildren.find(
          (c) => c.type === 'qualified_name' || c.type === 'name',
        );
        if (!qualifiedName) continue;

        const fullName = qualifiedName.text;
        if (seen.has(fullName)) continue;
        seen.add(fullName);

        // Use the top-level namespace as the package identifier
        const parts = fullName.split('\\');
        const topNamespace = parts[0];
        // Treat App\* as internal (same project), everything else as external
        const isExternal = topNamespace !== 'App';
        const extId = makeNodeId('external_dep', topNamespace);

        if (!nodes.find((n) => n.id === extId)) {
          nodes.push({
            id: extId,
            kind: 'external_dep',
            name: topNamespace,
            filePath: topNamespace,
            description: `PHP namespace: ${topNamespace}`,
            isExternal,
            language: null,
            meta: '{}',
          });
        }

        edges.push({
          id: makeEdgeId(fileNodeId, 'imports', extId),
          fromId: fileNodeId,
          toId: extId,
          kind: 'imports',
          reason: `uses ${fullName}`,
        });
      }
    }
  }

  private extractClasses(
    root: Parser.SyntaxNode,
    filePath: string,
    fileNodeId: string,
    nodes: Omit<GraphNode, 'updatedAt'>[],
    edges: Omit<GraphEdge, 'updatedAt'>[],
    source: string,
  ): void {
    for (const node of this.findByType(root, 'class_declaration')) {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) continue;
      const className = nameNode.text;
      const classId = makeNodeId('class', filePath, className);
      const snippet = truncate(source.slice(node.startIndex, node.startIndex + 120));

      nodes.push({
        id: classId,
        kind: 'class',
        name: className,
        filePath,
        description: `Class ${className}. ${snippet}`,
        isExternal: false,
        language: 'php',
        meta: '{}',
      });

      edges.push({
        id: makeEdgeId(fileNodeId, 'exports', classId),
        fromId: fileNodeId,
        toId: classId,
        kind: 'exports',
        reason: `defines class ${className}`,
      });

      // extends (base_clause)
      const baseClause = node.namedChildren.find((c) => c.type === 'base_clause');
      if (baseClause) {
        const parentNameNode = baseClause.namedChildren.find((c) => c.type === 'name');
        if (parentNameNode) {
          const parentName = parentNameNode.text;
          const parentId = makeNodeId('class', filePath, parentName);
          edges.push({
            id: makeEdgeId(classId, 'inherits', parentId),
            fromId: classId,
            toId: parentId,
            kind: 'inherits',
            reason: `extends ${parentName}`,
          });
        }
      }

      // implements (class_interface_clause)
      const ifaceClause = node.namedChildren.find((c) => c.type === 'class_interface_clause');
      if (ifaceClause) {
        for (const nameChild of ifaceClause.namedChildren.filter((c) => c.type === 'name')) {
          const ifaceName = nameChild.text;
          const ifaceId = makeNodeId('interface', filePath, ifaceName);
          edges.push({
            id: makeEdgeId(classId, 'implements', ifaceId),
            fromId: classId,
            toId: ifaceId,
            kind: 'implements',
            reason: `implements ${ifaceName}`,
          });
        }
      }

      // Extract methods within the class
      this.extractMethods(node, filePath, fileNodeId, nodes, edges);
    }
  }

  private extractInterfaces(
    root: Parser.SyntaxNode,
    filePath: string,
    fileNodeId: string,
    nodes: Omit<GraphNode, 'updatedAt'>[],
    edges: Omit<GraphEdge, 'updatedAt'>[],
  ): void {
    for (const node of this.findByType(root, 'interface_declaration')) {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) continue;
      const ifaceName = nameNode.text;
      const ifaceId = makeNodeId('interface', filePath, ifaceName);

      nodes.push({
        id: ifaceId,
        kind: 'interface',
        name: ifaceName,
        filePath,
        description: `Interface ${ifaceName}`,
        isExternal: false,
        language: 'php',
        meta: '{}',
      });

      edges.push({
        id: makeEdgeId(fileNodeId, 'exports', ifaceId),
        fromId: fileNodeId,
        toId: ifaceId,
        kind: 'exports',
        reason: `defines interface ${ifaceName}`,
      });
    }
  }

  private extractTraits(
    root: Parser.SyntaxNode,
    filePath: string,
    fileNodeId: string,
    nodes: Omit<GraphNode, 'updatedAt'>[],
    edges: Omit<GraphEdge, 'updatedAt'>[],
    source: string,
  ): void {
    for (const node of this.findByType(root, 'trait_declaration')) {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) continue;
      const traitName = nameNode.text;
      const traitId = makeNodeId('class', filePath, traitName);
      const snippet = truncate(source.slice(node.startIndex, node.startIndex + 120));

      nodes.push({
        id: traitId,
        kind: 'class',
        name: traitName,
        filePath,
        description: `Trait ${traitName}. ${snippet}`,
        isExternal: false,
        language: 'php',
        meta: JSON.stringify({ isTrait: true }),
      });

      edges.push({
        id: makeEdgeId(fileNodeId, 'exports', traitId),
        fromId: fileNodeId,
        toId: traitId,
        kind: 'exports',
        reason: `defines trait ${traitName}`,
      });
    }
  }

  private extractFunctions(
    root: Parser.SyntaxNode,
    filePath: string,
    fileNodeId: string,
    nodes: Omit<GraphNode, 'updatedAt'>[],
    edges: Omit<GraphEdge, 'updatedAt'>[],
  ): void {
    // Only top-level function_definition nodes (not methods inside classes)
    for (const child of root.namedChildren) {
      if (child.type !== 'function_definition') continue;
      const nameNode = child.childForFieldName('name');
      if (!nameNode) continue;
      const fnName = nameNode.text;
      const fnId = makeNodeId('function', filePath, fnName);

      nodes.push({
        id: fnId,
        kind: 'function',
        name: fnName,
        filePath,
        description: `Function ${fnName} in ${path.basename(filePath)}`,
        isExternal: false,
        language: 'php',
        meta: '{}',
      });

      edges.push({
        id: makeEdgeId(fileNodeId, 'exports', fnId),
        fromId: fileNodeId,
        toId: fnId,
        kind: 'exports',
        reason: `defines function ${fnName}`,
      });
    }
  }

  private extractMethods(
    classNode: Parser.SyntaxNode,
    filePath: string,
    fileNodeId: string,
    nodes: Omit<GraphNode, 'updatedAt'>[],
    edges: Omit<GraphEdge, 'updatedAt'>[],
  ): void {
    const declList = classNode.namedChildren.find((c) => c.type === 'declaration_list');
    if (!declList) return;

    const seen = new Set<string>();
    for (const child of declList.namedChildren) {
      if (child.type !== 'method_declaration') continue;
      const nameNode = child.childForFieldName('name');
      if (!nameNode) continue;
      const methodName = nameNode.text;
      if (seen.has(methodName)) continue;
      seen.add(methodName);

      const visibility =
        child.namedChildren.find((c) => c.type === 'visibility_modifier')?.text ?? 'public';

      const methodId = makeNodeId('method', filePath, methodName);
      nodes.push({
        id: methodId,
        kind: 'method',
        name: methodName,
        filePath,
        description: `Method ${methodName} in ${path.basename(filePath)}`,
        isExternal: false,
        language: 'php',
        meta: JSON.stringify({ visibility }),
      });

      edges.push({
        id: makeEdgeId(fileNodeId, 'exports', methodId),
        fromId: fileNodeId,
        toId: methodId,
        kind: 'exports',
        reason: `defines method ${methodName}`,
      });
    }
  }

  private findByType(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode[] {
    const results: Parser.SyntaxNode[] = [];
    const stack: Parser.SyntaxNode[] = [node];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur.type === type) results.push(cur);
      for (const child of cur.namedChildren) stack.push(child);
    }
    return results;
  }
}
