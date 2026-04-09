import { z } from 'zod';
import { DEFAULT_PREVIEW_FIELDS } from '../constants.js';
import { handleApiError, makeRequest, toJson, truncate } from '../client.js';
function summarizePreviewBody(body) {
    if (!body)
        return '';
    const stripped = body
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return truncate(stripped, 1500);
}
export function registerPreviewTools(server) {
    server.registerTool('meta_get_ad_preview', {
        title: 'Preview do Anúncio',
        description: 'Gera o preview HTML de um anúncio existente via ad_id.',
        inputSchema: z.object({
            ad_id: z.string().describe('ID do anúncio.'),
            ad_format: z.string().default('DESKTOP_FEED_STANDARD').describe('Formato do preview.'),
        }).strict(),
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    }, async ({ ad_id, ad_format }) => getPreview(`${ad_id}/previews`, ad_format));
    server.registerTool('meta_get_creative_preview', {
        title: 'Preview do Criativo',
        description: 'Gera preview HTML do criativo antes de publicar, via creative_id.',
        inputSchema: z.object({
            creative_id: z.string().describe('ID do criativo.'),
            ad_format: z.string().default('DESKTOP_FEED_STANDARD').describe('Formato do preview.'),
        }).strict(),
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    }, async ({ creative_id, ad_format }) => getPreview(`${creative_id}/previews`, ad_format));
}
async function getPreview(endpoint, ad_format) {
    try {
        const response = await makeRequest(endpoint, 'GET', {
            ad_format,
            fields: DEFAULT_PREVIEW_FIELDS,
        });
        const body = response.data?.[0]?.body || '';
        const result = {
            ad_format,
            body,
            summary: summarizePreviewBody(body),
        };
        return {
            content: [{ type: 'text', text: toJson(result) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return {
            isError: true,
            content: [{ type: 'text', text: handleApiError(error) }],
        };
    }
}
