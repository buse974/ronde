import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomToken } from './secrets.js';
import { requestKey } from './channels.js';

/** Nom du serveur MCP vu par claude, et règle d'outil à autoriser. */
export const RELAY_SERVER = 'canaux';
export const RELAY_TOOL = `mcp__${RELAY_SERVER}__appeler_canal`;

const isLoopback = (addr) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr);

/**
 * Relais des canaux API : un serveur MCP interne, joint par `claude -p` sur la
 * machine elle-même. Claude construit la requête ; ronde vérifie qu'elle est
 * permise, ajoute la clé du canal et l'envoie. Chaque passage (ou tour de
 * conversation) a son propre jeton, valable le temps du passage.
 */
export function createRelay({ channels, config, log = console }) {
  /** jeton → { label, allowed: Map(nom → { free, keys:Set }), calls: [] } */
  const sessions = new Map();

  function buildServer(session) {
    const server = new McpServer({ name: 'ronde-canaux', version: '1.0.0' });
    const names = [...session.allowed.keys()];
    const rules = names
      .map((n) => {
        const a = session.allowed.get(n);
        return a.free ? `« ${n} » : toutes les requêtes` : `« ${n} » : seulement les requêtes enregistrées pour cette ronde`;
      })
      .join(' ; ');
    server.registerTool(
      'appeler_canal',
      {
        title: 'Appeler un canal API',
        description:
          `Envoie une requête HTTP à un canal API configuré dans ronde. Canaux permis ici : ${rules}. ` +
          'Le chemin est relatif à l’URL du canal. La clé est ajoutée par ronde : ne l’écris jamais ; si l’API la veut dans la requête, écris {{cle}} à sa place. ' +
          'Renvoie le code HTTP et la réponse.',
        inputSchema: {
          canal: z.string(),
          methode: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
          chemin: z.string().default('/'),
          entetes: z.record(z.string()).optional(),
          corps: z.union([z.string(), z.record(z.any()), z.array(z.any())]).optional(),
        },
      },
      async ({ canal, methode, chemin, entetes, corps }) => {
        const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] });
        const a = session.allowed.get(canal);
        if (!a) return fail(`Canal « ${canal} » non permis ici. Canaux permis : ${names.join(', ') || 'aucun'}.`);
        const req = { methode, chemin, entetes, corps };
        if (!a.free && !a.keys.has(requestKey(req))) {
          return fail(`Requête non enregistrée pour cette ronde sur « ${canal} » : pendant un passage, seules les requêtes enregistrées sont permises (méthode, chemin et corps identiques).`);
        }
        try {
          const r = await channels.call(canal, req);
          session.calls.push({ canal, methode, chemin, statut: r.statut });
          return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
        } catch (err) {
          session.calls.push({ canal, methode, chemin, erreur: err.message });
          return fail(`Échec de l’appel à « ${canal} » : ${err.message}`);
        }
      },
    );
    return server;
  }

  return {
    /**
     * Ouvre une session pour un passage ou un tour de conversation.
     * allowed : [{ name, free, requests }]. Retourne null s'il n'y a rien à permettre.
     */
    open({ allowed, label }) {
      if (!allowed?.length) return null;
      const token = randomToken();
      const session = {
        label,
        calls: [],
        allowed: new Map(allowed.map((c) => [c.name, { free: !!c.free, keys: new Set((c.requests ?? []).map(requestKey)) }])),
      };
      sessions.set(token, session);
      const url = `http://127.0.0.1:${config.port}/relay/mcp`;
      return {
        mcpConfig: JSON.stringify({ mcpServers: { [RELAY_SERVER]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }),
        tool: RELAY_TOOL,
        calls: session.calls,
        close: () => sessions.delete(token),
      };
    },

    /** POST /relay/mcp : réservé à la machine elle-même, avec le jeton d'une session ouverte. */
    async handle(req, res) {
      const token = String(req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
      const session = sessions.get(token);
      if (!isLoopback(req.socket.remoteAddress) || !session) {
        return res.status(403).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Accès refusé.' }, id: null });
      }
      const server = buildServer(session);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        log.error(`[ronde] relais des canaux : ${err.message}`);
        if (!res.headersSent) res.status(500).end();
      }
    },

    get openSessions() {
      return sessions.size;
    },
  };
}
