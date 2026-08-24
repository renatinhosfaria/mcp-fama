# Design: separacao dos MCPs em repositorios independentes

## Contexto

O repositorio publico `renatinhosfaria/mcp-fama` contem tres servidores MCP que devem passar a ter historicos, remotos e diretorios Git independentes:

| Origem local | Destino GitHub |
| --- | --- |
| `mcp-minio/` | `renatinhosfaria/mcp-minio` |
| `mcp-postgres/` | `renatinhosfaria/mcp-famachat` |
| `meta-ads-mcp-server/` | `renatinhosfaria/mcp-meta-ads` |

O nome `mcp-ads-mcp-server/` informado inicialmente nao existe no workspace. O mapeamento aprovado usa `meta-ads-mcp-server/`. Os nomes dos diretorios locais e dos pacotes Node.js nao serao alterados.

Os tres repositorios de destino ja existem, sao publicos e estao vazios. O repositorio de origem possui quatro branches publicadas, sem tags. As tres branches auxiliares publicadas ja estao incorporadas a `main`. A `main` local possui um commit ainda nao publicado, e `mcp-postgres/src/index.ts` possui uma alteracao local nao commitada que deve ser preservada.

## Objetivos

- Preservar, em cada destino, os commits da `main` que afetaram o respectivo servidor, mantendo autores, datas e mensagens sempre que o filtro permitir.
- Publicar cada destino com uma branch `main` funcional e independente.
- Manter os caminhos locais existentes e transforma-los em repositorios Git aninhados independentes.
- Preservar arquivos locais ignorados, incluindo configuracoes de ambiente, sem publica-los.
- Eliminar credenciais e artefatos gerados dos novos historicos.
- Sanitizar as referencias publicadas do repositorio original antes de arquiva-lo.
- Arquivar `renatinhosfaria/mcp-fama` somente depois da validacao completa dos tres destinos.

## Nao objetivos

- Renomear `mcp-postgres/`, `meta-ads-mcp-server/` ou os nomes dos pacotes em `package.json`.
- Alterar APIs, comportamento funcional, configuracoes de producao ou contratos MCP.
- Publicar `.env`, credenciais, arquivos locais ignorados ou backups.
- Migrar branches auxiliares ja incorporadas como branches permanentes nos novos repositorios.
- Apagar imediatamente o backup local que permite rollback da reescrita.

## Estado observado

- `mcp-minio/`: 3 commits relevantes e 22 arquivos rastreados no estado atual.
- `mcp-postgres/`: 9 commits relevantes e 36 arquivos rastreados, alem da alteracao local em `src/index.ts`.
- `meta-ads-mcp-server/`: 19 commits relevantes e 4.249 arquivos rastreados.
- O Meta Ads rastreia 4.147 arquivos sob `node_modules/` e 38 arquivos sob `dist/`.
- Um `.env` do Meta Ads existiu no historico publicado e continha credenciais. Seus valores nao devem aparecer em logs, planos ou relatorios.
- Arquivar um repositorio no GitHub nao remove objetos historicos; por isso a sanitizacao precede o arquivamento.

## Abordagem escolhida

Cada destino sera produzido em um clone descartavel do repositorio local. `git-filter-repo` filtrara a `main` pelo prefixo do servidor e movera o conteudo desse prefixo para a raiz do novo repositorio. A extracao parte da `main` local para incluir o commit local de Meta Ads ainda nao publicado.

No destino de Meta Ads, uma segunda filtragem removera `.env`, `node_modules/` e `dist/` de todos os commits. Um `.gitignore` cobrira esses caminhos no estado final. Nos demais destinos, a filtragem e a varredura de segredos confirmarao que nenhum arquivo sensivel foi transportado.

A alteracao nao commitada em `mcp-postgres/src/index.ts` sera exportada como patch, validada para conter apenas essa mudanca, aplicada ao repositorio filtrado `mcp-famachat` e registrada em um commit proprio. O arquivo do usuario no repositorio original nao sera descartado nem sobrescrito.

Os pushes iniciais dos destinos serao pushes normais para repositorios vazios. Nenhum force-push sera usado nos tres novos repositorios.

## Sanitizacao do repositorio original

Antes de qualquer reescrita sera criado um Git bundle local com todas as referencias, permissao de arquivo restrita e verificacao por `git bundle verify`. O hash de cada referencia remota sera capturado para proteger a operacao contra alteracoes concorrentes.

A sanitizacao do original ocorrera em um clone espelho separado e removera `meta-ads-mcp-server/.env` de todas as referencias publicadas. A varredura de segredos sera executada sobre todo o historico reescrito. As quatro branches publicadas serao atualizadas com force-push condicionado aos hashes previamente observados; mudanca concorrente interrompera a execucao.

O backup contem o historico sensivel antigo e, portanto, permanecera apenas local, com permissao `0600`. Ele sera mantido para rollback ate confirmacao posterior do usuario.

## Estado local final

Cada um dos tres diretorios existentes recebera seu proprio `.git` e apontara para o respectivo remoto:

- `/root/mcp-fama/mcp-minio/.git`
- `/root/mcp-fama/mcp-postgres/.git`
- `/root/mcp-fama/meta-ads-mcp-server/.git`

A instalacao dos metadados Git sera feita sem remover os arquivos existentes. Arquivos ignorados continuarao locais. A partir de cada subdiretorio, `git rev-parse --show-toplevel` devera retornar o proprio subdiretorio. O repositorio pai permanecera local como registro do projeto arquivado, mas nao sera usado para desenvolver os tres servidores.

## Validacao e gates

Antes de qualquer push:

- verificar integridade com `git fsck --full` e `git fsck --no-reflogs --unreachable`;
- confirmar que `.env`, `node_modules/` e `dist/` nao estao rastreados onde proibidos;
- executar uma varredura de segredos com saida redigida;
- comparar a lista e a ordem dos commits relevantes entre origem e destinos;
- executar `npm run build` em todos os servidores;
- executar `npm run typecheck` em MinIO e FamaChat;
- executar `npm test` em FamaChat;
- confirmar que o build do Meta Ads recria `dist/` sem rastrea-lo.

Depois dos pushes:

- clonar cada destino em diretorio temporario limpo;
- repetir verificacao Git e testes aplicaveis;
- confirmar `main` como branch padrao e os remotos corretos;
- confirmar que nenhuma referencia inesperada foi publicada.

Somente depois desses gates o original sera sanitizado, novamente verificado e arquivado pela API do GitHub. A credencial historicamente exposta deve ser rotacionada no sistema emissor; a reescrita Git reduz a exposicao, mas nao invalida uma credencial copiada anteriormente.

## Recuperacao

- Antes dos pushes dos destinos, basta descartar os clones temporarios.
- Como os destinos estao vazios, uma falha durante o primeiro push sera corrigida antes de definir o repositorio como concluido.
- Se a reescrita do original precisar ser revertida, as referencias poderao ser restauradas a partir do bundle local.
- Se qualquer hash remoto mudar durante a migracao, a operacao sera interrompida para nova auditoria; nenhum force-push cego sera realizado.
- O arquivamento e o ultimo passo e pode ser revertido separadamente no GitHub sem alterar os historicos.
