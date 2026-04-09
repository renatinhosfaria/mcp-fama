import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { query } from '../../db.js';

export function registerImoveisTools(server: McpServer) {
  // 1. search_properties - Search empreendimentos with filters
  server.registerTool(
    'search_properties',
    {
      title: 'Search Properties',
      description:
        'Search real-estate properties (empreendimentos) by name, neighborhood, or city. ' +
        'Supports filters for property type, price range, city, neighborhood, and zone. ' +
        'Returns apartment count per property.',
      inputSchema: {
        search: z.string().optional().describe('Search term (ILIKE on name, neighborhood, city)'),
        property_type: z.string().optional().describe('Filter by tipo_imovel'),
        min_price: z.number().optional().describe('Minimum price (from cheapest apartment in the property)'),
        max_price: z.number().optional().describe('Maximum price (from cheapest apartment in the property)'),
        city: z.string().optional().describe('Filter by cidade_empreendimento'),
        neighborhood: z.string().optional().describe('Filter by bairro_empreendimento'),
        zone: z.string().optional().describe('Filter by zona_empreendimento'),
        limit: z.number().optional().default(20).describe('Max results (default 20)'),
        offset: z.number().optional().default(0).describe('Offset for pagination'),
      },
    },
    async ({ search, property_type, min_price, max_price, city, neighborhood, zone, limit, offset }) => {
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        if (search) {
          conditions.push(
            `(e.nome_empreendimento ILIKE $${idx} OR e.bairro_empreendimento ILIKE $${idx} OR e.cidade_empreendimento ILIKE $${idx})`
          );
          params.push(`%${search}%`);
          idx++;
        }

        if (property_type) {
          conditions.push(`e.tipo_imovel = $${idx}`);
          params.push(property_type);
          idx++;
        }

        if (city) {
          conditions.push(`e.cidade_empreendimento ILIKE $${idx}`);
          params.push(`%${city}%`);
          idx++;
        }

        if (neighborhood) {
          conditions.push(`e.bairro_empreendimento ILIKE $${idx}`);
          params.push(`%${neighborhood}%`);
          idx++;
        }

        if (zone) {
          conditions.push(`e.zona_empreendimento = $${idx}`);
          params.push(zone);
          idx++;
        }

        if (min_price !== undefined) {
          conditions.push(`apt_stats.min_price >= $${idx}`);
          params.push(min_price);
          idx++;
        }

        if (max_price !== undefined) {
          conditions.push(`apt_stats.min_price <= $${idx}`);
          params.push(max_price);
          idx++;
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        params.push(limit);
        const limitIdx = idx;
        idx++;
        params.push(offset);
        const offsetIdx = idx;

        const sql = `
          SELECT
            e.id_empreendimento,
            e.nome_empreendimento,
            e.tipo_imovel,
            e.rua_avenida_empreendimento,
            e.numero_empreendimento,
            e.bairro_empreendimento,
            e.cidade_empreendimento,
            e.estado_empreendimento,
            e.zona_empreendimento,
            e.status,
            e.valor_condominio_empreendimento,
            e.url_foto_capa_empreendimento,
            e.prazo_entrega_empreendimento,
            COALESCE(apt_stats.apartment_count, 0) AS apartment_count,
            apt_stats.min_price,
            apt_stats.max_price,
            apt_stats.avg_price
          FROM imoveis_empreendimentos e
          LEFT JOIN LATERAL (
            SELECT
              COUNT(*) AS apartment_count,
              MIN(a.valor_venda_apartamento) AS min_price,
              MAX(a.valor_venda_apartamento) AS max_price,
              ROUND(AVG(a.valor_venda_apartamento), 2) AS avg_price
            FROM imoveis_apartamentos a
            WHERE a.id_empreendimento = e.id_empreendimento
          ) apt_stats ON true
          ${where}
          ORDER BY e.nome_empreendimento
          LIMIT $${limitIdx} OFFSET $${offsetIdx}
        `;

        const result = await query(sql, params);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ count: result.rows.length, properties: result.rows }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error searching properties: ${msg}` }], isError: true };
      }
    }
  );

  // 2. get_property - Full detail of a single property
  server.registerTool(
    'get_property',
    {
      title: 'Get Property Details',
      description:
        'Get full details of a property (empreendimento) by ID, including all apartments, ' +
        'construtora info, and construtora contacts.',
      inputSchema: {
        property_id: z.number().describe('id_empreendimento'),
      },
    },
    async ({ property_id }) => {
      try {
        const [propertyRes, apartmentsRes, construtoraRes] = await Promise.all([
          query(
            `SELECT e.*, c.nome_construtora, c.razao_social, c.cpf_cnpj
             FROM imoveis_empreendimentos e
             LEFT JOIN imoveis_construtoras c ON e.id_construtora = c.id_construtora
             WHERE e.id_empreendimento = $1`,
            [property_id]
          ),
          query(
            `SELECT * FROM imoveis_apartamentos
             WHERE id_empreendimento = $1
             ORDER BY titulo_descritivo_apartamento`,
            [property_id]
          ),
          query(
            `SELECT cc.*
             FROM imoveis_contatos_construtora cc
             JOIN imoveis_empreendimentos e ON e.id_construtora = cc.id_construtora
             WHERE e.id_empreendimento = $1
             ORDER BY cc.nome`,
            [property_id]
          ),
        ]);

        if (propertyRes.rows.length === 0) {
          return {
            content: [{ type: 'text', text: `Property with id ${property_id} not found.` }],
            isError: true,
          };
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              property: propertyRes.rows[0],
              apartments: apartmentsRes.rows,
              construtora_contacts: construtoraRes.rows,
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error fetching property: ${msg}` }], isError: true };
      }
    }
  );

  // 3. property_availability - Available apartments with filters
  server.registerTool(
    'property_availability',
    {
      title: 'Property Availability',
      description:
        'List available apartments filtered by status. Supports filters for property, ' +
        'minimum rooms, and maximum price.',
      inputSchema: {
        property_id: z.number().optional().describe('Filter by id_empreendimento'),
        status: z.string().optional().describe('Apartment status filter (e.g. "Em construção", "disponivel"). When omitted returns all.'),
        min_rooms: z.number().optional().describe('Minimum number of quartos'),
        max_price: z.number().optional().describe('Maximum valor_venda_apartamento'),
      },
    },
    async ({ property_id, status, min_rooms, max_price }) => {
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        if (status) {
          conditions.push(`a.status_apartamento = $${idx}`);
          params.push(status);
          idx++;
        }

        if (property_id !== undefined) {
          conditions.push(`a.id_empreendimento = $${idx}`);
          params.push(property_id);
          idx++;
        }

        if (min_rooms !== undefined) {
          conditions.push(`a.quartos_apartamento >= $${idx}`);
          params.push(min_rooms);
          idx++;
        }

        if (max_price !== undefined) {
          conditions.push(`a.valor_venda_apartamento <= $${idx}`);
          params.push(max_price);
          idx++;
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const sql = `
          SELECT
            a.id_apartamento,
            a.id_empreendimento,
            e.nome_empreendimento,
            a.titulo_descritivo_apartamento,
            a.status_apartamento,
            a.quartos_apartamento,
            a.suites_apartamento,
            a.banheiros_apartamento,
            a.area_privativa_apartamento,
            a.vagas_garagem_apartamento,
            a.tipo_garagem_apartamento,
            a.sacada_varanda_apartamento,
            a.valor_venda_apartamento,
            a.caracteristicas_apartamento
          FROM imoveis_apartamentos a
          JOIN imoveis_empreendimentos e ON a.id_empreendimento = e.id_empreendimento
          ${where}
          ORDER BY e.nome_empreendimento, a.valor_venda_apartamento
        `;

        const result = await query(sql, params);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ count: result.rows.length, apartments: result.rows }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error checking availability: ${msg}` }], isError: true };
      }
    }
  );

  // 4. search_apartments - Direct apartment search with location info
  server.registerTool(
    'search_apartments',
    {
      title: 'Search Apartments',
      description:
        'Search apartments directly with filters for rooms, area, price, and status. ' +
        'Joins empreendimento for location information.',
      inputSchema: {
        rooms: z.number().optional().describe('Exact number of quartos_apartamento'),
        min_area: z.number().optional().describe('Minimum area_privativa_apartamento'),
        max_price: z.number().optional().describe('Maximum valor_venda_apartamento'),
        status: z.string().optional().describe('Filter by status_apartamento'),
        limit: z.number().optional().default(20).describe('Max results (default 20)'),
        offset: z.number().optional().default(0).describe('Offset for pagination'),
      },
    },
    async ({ rooms, min_area, max_price, status, limit, offset }) => {
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        if (rooms !== undefined) {
          conditions.push(`a.quartos_apartamento = $${idx}`);
          params.push(rooms);
          idx++;
        }

        if (min_area !== undefined) {
          conditions.push(`a.area_privativa_apartamento >= $${idx}`);
          params.push(min_area);
          idx++;
        }

        if (max_price !== undefined) {
          conditions.push(`a.valor_venda_apartamento <= $${idx}`);
          params.push(max_price);
          idx++;
        }

        if (status) {
          conditions.push(`a.status_apartamento = $${idx}`);
          params.push(status);
          idx++;
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        params.push(limit);
        const limitIdx = idx;
        idx++;
        params.push(offset);
        const offsetIdx = idx;

        const sql = `
          SELECT
            a.id_apartamento,
            a.id_empreendimento,
            e.nome_empreendimento,
            e.bairro_empreendimento,
            e.cidade_empreendimento,
            e.estado_empreendimento,
            e.zona_empreendimento,
            a.titulo_descritivo_apartamento,
            a.descricao_apartamento,
            a.status_apartamento,
            a.quartos_apartamento,
            a.suites_apartamento,
            a.banheiros_apartamento,
            a.area_privativa_apartamento,
            a.vagas_garagem_apartamento,
            a.tipo_garagem_apartamento,
            a.sacada_varanda_apartamento,
            a.valor_venda_apartamento,
            a.caracteristicas_apartamento,
            a.status_publicacao_apartamento
          FROM imoveis_apartamentos a
          JOIN imoveis_empreendimentos e ON a.id_empreendimento = e.id_empreendimento
          ${where}
          ORDER BY a.valor_venda_apartamento ASC
          LIMIT $${limitIdx} OFFSET $${offsetIdx}
        `;

        const result = await query(sql, params);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ count: result.rows.length, apartments: result.rows }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error searching apartments: ${msg}` }], isError: true };
      }
    }
  );

  // 5. property_price_analysis - Price stats by neighborhood/zone
  server.registerTool(
    'property_price_analysis',
    {
      title: 'Property Price Analysis',
      description:
        'Get price statistics (min, max, avg) for apartments grouped by neighborhood and zone. ' +
        'Optional filters by neighborhood or zone.',
      inputSchema: {
        neighborhood: z.string().optional().describe('Filter by bairro_empreendimento'),
        zone: z.string().optional().describe('Filter by zona_empreendimento'),
      },
    },
    async ({ neighborhood, zone }) => {
      try {
        const conditions: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        if (neighborhood) {
          conditions.push(`e.bairro_empreendimento ILIKE $${idx}`);
          params.push(`%${neighborhood}%`);
          idx++;
        }

        if (zone) {
          conditions.push(`e.zona_empreendimento = $${idx}`);
          params.push(zone);
          idx++;
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const sql = `
          SELECT
            e.bairro_empreendimento AS neighborhood,
            e.zona_empreendimento AS zone,
            COUNT(DISTINCT e.id_empreendimento) AS property_count,
            COUNT(a.id_apartamento) AS apartment_count,
            MIN(a.valor_venda_apartamento) AS min_price,
            MAX(a.valor_venda_apartamento) AS max_price,
            ROUND(AVG(a.valor_venda_apartamento), 2) AS avg_price,
            ROUND(AVG(a.area_privativa_apartamento), 2) AS avg_area,
            ROUND(AVG(a.valor_venda_apartamento / NULLIF(a.area_privativa_apartamento, 0)), 2) AS avg_price_per_sqm
          FROM imoveis_empreendimentos e
          JOIN imoveis_apartamentos a ON e.id_empreendimento = a.id_empreendimento
          ${where}
          GROUP BY e.bairro_empreendimento, e.zona_empreendimento
          ORDER BY avg_price DESC
        `;

        const result = await query(sql, params);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ analysis: result.rows }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error analyzing prices: ${msg}` }], isError: true };
      }
    }
  );
}
