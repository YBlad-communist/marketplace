import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Предохранитель «массовые операции только со where».
 * Баг-паттерн: updateMany/deleteMany без where или с where: {} срабатывает
 * для ВСЕХ строк таблицы. Это статическая проверка через AST TypeScript —
 * она всегда запускается и ломает тест при попытке добавить «голую»
 * массовую операцию.
 */

const SOURCES = [path.join(process.cwd(), 'src'), path.join(process.cwd(), '..', 'worker', 'src')];

function listTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

interface Violation {
  file: string;
  line: number;
  method: string;
}

function findMassOpViolations(file: string): Violation[] {
  const sourceText = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: Violation[] = [];

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === 'updateMany' || node.expression.name.text === 'deleteMany')
    ) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      if (!hasScopedWhere(node)) {
        violations.push({ file, line: line + 1, method: node.expression.name.text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

function hasScopedWhere(call: ts.CallExpression): boolean {
  const arg = call.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return false;
  const whereProp = arg.properties.find(
    (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'where'
  );
  if (!whereProp || !ts.isPropertyAssignment(whereProp)) return false;
  const init = whereProp.initializer;
  // where обязан быть непустым объектным литералом (или переменной, уже
  // несущей где-то where: — грубый случай пропустим здесь, проверка where: {}
  // отдельно ниже).
  if (ts.isObjectLiteralExpression(init)) {
    return init.properties.length > 0;
  }
  return true;
}

describe('предохранитель массовых операций (updateMany/deleteMany)', () => {
  it('каждая updateMany/deleteMany имеет непустой where', () => {
    const violations: Violation[] = [];
    for (const dir of SOURCES) {
      for (const file of listTsFiles(dir)) {
        violations.push(...findMassOpViolations(file));
      }
    }
    const rendered = violations
      .map((v) => `${v.file.replaceAll('\\', '/')}:${v.line} — ${v.method} без where или с where: {}`)
      .join('\n');
    expect(rendered, `Нарушения счёпинга массовых операций:\n${rendered}\n`).toBe('');
  });
});