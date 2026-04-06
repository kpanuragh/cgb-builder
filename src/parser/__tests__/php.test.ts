/**
 * Unit tests for the PHP language adapter.
 *
 * Verifies extraction of use statements, classes, interfaces, traits,
 * functions, methods, extends, and implements from PHP source.
 */

import { PhpAdapter } from '../adapters/php.js';

const adapter = new PhpAdapter();

// ─── Fixture: typical Laravel controller ─────────────────────────────────────

const LARAVEL_CONTROLLER = `<?php

namespace App\\Http\\Controllers;

use Illuminate\\Http\\Request;
use App\\Models\\User;
use App\\Services\\AuthService;

class UserController extends Controller implements Authenticatable
{
    public function index(Request $request): JsonResponse
    {
        $users = User::all();
        return response()->json($users);
    }

    public function store(Request $request): JsonResponse
    {
        $user = User::create($request->validated());
        return response()->json($user, 201);
    }

    private function helper(): void {}
}
`;

const INTERFACE_SOURCE = `<?php

namespace App\\Contracts;

interface UserRepositoryInterface
{
    public function findById(int $id): ?User;
    public function findAll(): array;
}
`;

const TRAIT_SOURCE = `<?php

namespace App\\Concerns;

trait HasApiTokens
{
    public function createToken(string $name): string
    {
        return 'token';
    }

    public function revokeToken(int $id): void {}
}
`;

const STANDALONE_FUNCTIONS = `<?php

function helperOne(): string
{
    return 'hello';
}

function helperTwo(int $x): int
{
    return $x * 2;
}
`;

const MULTIPLE_IMPLEMENTS = `<?php

class PaymentService extends BaseService implements Billable, Refundable
{
    public function charge(): void {}
}
`;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('PhpAdapter', () => {
  it('has language set to php', () => {
    expect(adapter.language).toBe('php');
  });

  describe('use statements (imports)', () => {
    it('extracts use statements as import edges', async () => {
      const result = await adapter.parse('/app/Http/Controllers/UserController.php', LARAVEL_CONTROLLER);
      const importEdges = result.edges.filter((e) => e.kind === 'imports');
      expect(importEdges.length).toBe(3);
    });

    it('marks non-App namespaces as external', async () => {
      const result = await adapter.parse('/app/Http/Controllers/UserController.php', LARAVEL_CONTROLLER);
      const illuminateNode = result.nodes.find((n) => n.name === 'Illuminate');
      expect(illuminateNode).toBeDefined();
      expect(illuminateNode!.isExternal).toBe(true);
    });

    it('marks App namespace as internal', async () => {
      const result = await adapter.parse('/app/Http/Controllers/UserController.php', LARAVEL_CONTROLLER);
      const appNode = result.nodes.find((n) => n.name === 'App');
      expect(appNode).toBeDefined();
      expect(appNode!.isExternal).toBe(false);
    });

    it('includes the full use path in edge reason', async () => {
      const result = await adapter.parse('/app/Http/Controllers/UserController.php', LARAVEL_CONTROLLER);
      const importEdges = result.edges.filter((e) => e.kind === 'imports');
      const reasons = importEdges.map((e) => e.reason);
      expect(reasons).toContain('uses Illuminate\\Http\\Request');
    });
  });

  describe('class declarations', () => {
    it('extracts class node', async () => {
      const result = await adapter.parse('/app/Http/Controllers/UserController.php', LARAVEL_CONTROLLER);
      const classNode = result.nodes.find((n) => n.kind === 'class' && n.name === 'UserController');
      expect(classNode).toBeDefined();
      expect(classNode!.language).toBe('php');
    });

    it('creates exports edge from file to class', async () => {
      const result = await adapter.parse('/app/Http/Controllers/UserController.php', LARAVEL_CONTROLLER);
      const exportEdge = result.edges.find(
        (e) => e.kind === 'exports' && e.reason.includes('UserController'),
      );
      expect(exportEdge).toBeDefined();
    });

    it('extracts extends as inherits edge', async () => {
      const result = await adapter.parse('/app/Http/Controllers/UserController.php', LARAVEL_CONTROLLER);
      const inheritsEdge = result.edges.find((e) => e.kind === 'inherits');
      expect(inheritsEdge).toBeDefined();
      expect(inheritsEdge!.reason).toBe('extends Controller');
    });

    it('extracts implements as implements edge', async () => {
      const result = await adapter.parse('/app/Http/Controllers/UserController.php', LARAVEL_CONTROLLER);
      const implEdge = result.edges.find((e) => e.kind === 'implements');
      expect(implEdge).toBeDefined();
      expect(implEdge!.reason).toBe('implements Authenticatable');
    });

    it('handles multiple implements', async () => {
      const result = await adapter.parse('/app/PaymentService.php', MULTIPLE_IMPLEMENTS);
      const implEdges = result.edges.filter((e) => e.kind === 'implements');
      expect(implEdges.length).toBe(2);
      const reasons = implEdges.map((e) => e.reason);
      expect(reasons).toContain('implements Billable');
      expect(reasons).toContain('implements Refundable');
    });
  });

  describe('interface declarations', () => {
    it('extracts interface node', async () => {
      const result = await adapter.parse('/app/Contracts/UserRepositoryInterface.php', INTERFACE_SOURCE);
      const ifaceNode = result.nodes.find(
        (n) => n.kind === 'interface' && n.name === 'UserRepositoryInterface',
      );
      expect(ifaceNode).toBeDefined();
      expect(ifaceNode!.language).toBe('php');
    });

    it('creates exports edge from file to interface', async () => {
      const result = await adapter.parse('/app/Contracts/UserRepositoryInterface.php', INTERFACE_SOURCE);
      const exportEdge = result.edges.find(
        (e) => e.kind === 'exports' && e.reason.includes('UserRepositoryInterface'),
      );
      expect(exportEdge).toBeDefined();
    });
  });

  describe('trait declarations', () => {
    it('extracts trait as class node with isTrait metadata', async () => {
      const result = await adapter.parse('/app/Concerns/HasApiTokens.php', TRAIT_SOURCE);
      const traitNode = result.nodes.find((n) => n.name === 'HasApiTokens');
      expect(traitNode).toBeDefined();
      expect(traitNode!.kind).toBe('class');
      expect(JSON.parse(traitNode!.meta)).toEqual({ isTrait: true });
    });

    it('creates exports edge from file to trait', async () => {
      const result = await adapter.parse('/app/Concerns/HasApiTokens.php', TRAIT_SOURCE);
      const exportEdge = result.edges.find(
        (e) => e.kind === 'exports' && e.reason.includes('HasApiTokens'),
      );
      expect(exportEdge).toBeDefined();
    });
  });

  describe('method declarations', () => {
    it('extracts methods from classes', async () => {
      const result = await adapter.parse('/app/Http/Controllers/UserController.php', LARAVEL_CONTROLLER);
      const methods = result.nodes.filter((n) => n.kind === 'method');
      const methodNames = methods.map((n) => n.name);
      expect(methodNames).toContain('index');
      expect(methodNames).toContain('store');
      expect(methodNames).toContain('helper');
    });

    it('stores visibility in method metadata', async () => {
      const result = await adapter.parse('/app/Http/Controllers/UserController.php', LARAVEL_CONTROLLER);
      const helperMethod = result.nodes.find((n) => n.kind === 'method' && n.name === 'helper');
      expect(helperMethod).toBeDefined();
      expect(JSON.parse(helperMethod!.meta)).toEqual({ visibility: 'private' });
    });
  });

  describe('standalone function declarations', () => {
    it('extracts top-level functions', async () => {
      const result = await adapter.parse('/helpers.php', STANDALONE_FUNCTIONS);
      const fns = result.nodes.filter((n) => n.kind === 'function');
      expect(fns.length).toBe(2);
      const fnNames = fns.map((n) => n.name);
      expect(fnNames).toContain('helperOne');
      expect(fnNames).toContain('helperTwo');
    });
  });

  describe('file node', () => {
    it('always creates a file node', async () => {
      const result = await adapter.parse('/app/test.php', '<?php\n');
      const fileNode = result.nodes.find((n) => n.kind === 'file');
      expect(fileNode).toBeDefined();
      expect(fileNode!.language).toBe('php');
    });

    it('stores namespace in file node metadata', async () => {
      const result = await adapter.parse('/app/Http/Controllers/UserController.php', LARAVEL_CONTROLLER);
      const fileNode = result.nodes.find((n) => n.kind === 'file');
      expect(fileNode).toBeDefined();
      const meta = JSON.parse(fileNode!.meta);
      expect(meta.namespace).toBe('App\\Http\\Controllers');
    });
  });
});
