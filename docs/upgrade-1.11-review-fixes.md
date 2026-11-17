# Revisão independente: correções de lifecycle, consultas e proxy

17/11/2026. Branch `chore/upgrade-zapo-1.11-session-safety`, base da rodada `1648f1d`.
Esta rodada trata os cinco defeitos reproduzidos na revisão independente do PR #3.

## Impacto sobre o reinício do socket

Os achados não demonstram que reiniciar o socket apague credenciais ou desconecte todas as
contas. Há condições específicas de concorrência e duas falhas da capacidade nova de proxy:

| Achado                                                     | Relação com o upgrade                                        | Consequência reproduzida                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Restart pós-pareamento ultrapassa disconnect posterior     | Novo caminho de disparo de restart expõe ordenação incorreta | Manager confirma disconnect enquanto uma conexão substituta permanece ativa |
| Configuração atrasada inicia comms cancelado               | Residual, já presente na master do fork                      | Início obsoleto pode tentar conectar e atrasar o desligamento               |
| Rejeição tardia de envio remove consulta nova com mesmo ID | Residual, já presente na master do fork                      | IQ correto perde correlação e expira após reconexão/reutilização de ID      |
| Proxy HTTP CONNECT com endereço IPv6 não conecta           | Defeito da capacidade nova de proxy TCP móvel                | Literal com colchetes é interpretado como hostname DNS                      |
| Erro de URL malformada contém usuário/senha                | Defeito do parser novo de proxy                              | Credenciais do proxy aparecem no erro e no log de falha de conexão          |

O primeiro achado foi comprovado no manager com comms sintético. Não se afirma que tenha
ocorrido pelo fluxo completo de `WaClient.disconnect()` em produção. O caso de rejeição de
envio foi também reproduzido nesta rodada por `WaClient` com reconexão WebSocket/Noise local.
Os segredos expostos pelo quinto caso são do proxy, não as chaves WhatsApp gravadas no banco.

## Decisões e mudanças pequenas

`WaConnectionManager` captura a geração do restart quando ele é solicitado, antes de entrar
na fila. Ao executar, verifica essa geração antes de tocar no comms. Dessa forma, um pedido
posterior de disconnect ganha precedência. A geração continua sendo conferida depois de
parar o socket antigo e é agora conferida imediatamente após `buildCommsConfig`, antes de
construir, registrar ou iniciar outro socket. Não mudam tags, tempos ou sinais do protocolo
de pareamento: mudam a ordenação interna e o descarte de operações canceladas.

`WaNodeOrchestrator` associa o callback de timeout e o catch do envio à entrada original do
mapa. Ambos só removem a pendência se a identidade da entrada ainda for a mesma. Falha tardia
de consulta já encerrada é observada em trace e não afeta uma consulta substituta. O
correlacionador, os timers e os IDs automáticos existentes continuam sendo usados; não há
um segundo mapa nem uma fila nova.

`toTcpProxyEndpoint` remove os colchetes apenas do hostname literal validado por `URL`,
para o dial TCP. Hostnames DNS e IPv4 mantêm seu valor. Uma URL malformada gera mensagem
estática sem a entrada, sem anexar o erro original que poderia carregar o segredo.

O patch não altera stores, schema, migrações, configuração do banco ou limpeza de credenciais.
Não faz merge na master, publicação, deploy ou mudança da dependência do WayAPI.

## TDD antes da implementação

Commit de testes antes do runtime: `3c04dd0`. Quinze casos foram acrescentados ao core e um
ao gate de WebSocket/Noise. Na rodada vermelha, os quatro arquivos focados tiveram 32
aprovações e 14 falhas; o novo loopback teve uma falha por timeout da consulta nova. Um dos
quinze casos novos, cancelamento enquanto o socket antigo já está parando, já passava e
protege um checkpoint que existia.

Os cenários permanentes cobrem:

- Restart disparado por 515, close ou fallback seguido de disconnect no mesmo turno.
- Os três disparos com a fila de lifecycle ocupada, antes de executar o restart.
- Disconnect durante o await de parada do comms antigo e durante a construção da configuração.
- Rejeição tardia do envio após cancelamento, timeout ou sucesso da consulta anterior,
  seguida de reutilização do mesmo ID. A consulta nova precisa receber sua resposta.
- Dial normalizado de IPv6, preservando IPv4 e DNS; CONNECT e troca de bytes em loopback IPv6.
- Ausência de userinfo no erro e no log efetivo `socket open failed` do WaComms.
- Envio real pela conexão antiga, completion suspensa, disconnect/connect e nova consulta
  com mesmo ID. A rejeição antiga é liberada antes da resposta nova, que deve concluir.
  O mesmo fixture preserva o teste de resposta decodificada da geração anterior e confere
  o fingerprint das chaves antes/depois.

Os testes não afirmam o comportamento defeituoso como sucesso. No baseline, exigem zero
restarts/starts obsoletos, uma consulta nova intacta e mensagens sem segredos e falham. O
loopback não reconecta para resolver saturação: a reconexão é um estímulo deliberado do
cenário de isolamento, com duas autenticações esperadas.

O fixture do teste de logs foi ajustado durante a rodada: WaWebSocket não registrava o erro
do construtor nesse caminho. O teste final passa pelo WaComms, que registra a falha. Foi
reexecutado contra o parser original e reproduziu o vazamento no log, antes da validação
verde com o parser corrigido. Não foi necessário adicionar um log só para satisfazer o teste.

## Validação final

| Verificação                                             | Resultado                                    |
| ------------------------------------------------------- | -------------------------------------------- |
| Quatro arquivos focados de lifecycle, consultas e proxy | 46 passaram                                  |
| Core completo                                           | 1425 passaram, um skip anterior              |
| Gate de fila                                            | 7 passaram                                   |
| WebSocket/Noise local                                   | 16 passaram                                  |
| Persistência de credenciais e upgrade/rollback          | 17 passaram em cada uma das duas referências |
| Build core CJS/ESM/types                                | Passou                                       |
| Typecheck core, exemplos, benchmarks e 11 pacotes       | Passou                                       |

Também passaram os 217 testes completos do fake-server, os seis testes do publisher com
executor falso e o gate de tarballs CJS/ESM com SQLite persistido. Lint e format do
repositório passaram. Não foi efetuada publicação. A matriz de 198 testes do WayAPI não
foi repetida nesta rodada; seus resultados de 15/11 permanecem históricos.

Os resultados desta rodada são registrados junto aos logs locais em
`avaliacao-upgrade-zapo/review-fixes-2026-11-17`. O manifesto de verificação associa SHAs e
checksums dos artefatos. O relatório anterior é histórico e não é uma execução independente
da versão corrigida nesta rodada.

## Limites que permanecem

Não houve WhatsApp real, banco de produção nem validação contra `wa-web/`/`wa-mob/`, ausentes
neste checkout. A correção preserva as decisões de protocolo já codificadas. O canário real
e a verificação do processo antigo em execução, shutdown e caminho absoluto do banco seguem
pendentes antes de produção. Reiniciar o processo encerra o socket físico; preservar e
retomar a sessão não significa manter esse socket aberto durante a troca.

Handlers arbitrários já iniciados não são cancelados à força. Não se provou isolamento
completo de efeitos de um callback antigo que ainda escreve no banco, nem shutdown com I/O
de banco que nunca termina. Filtros raw arbitrários mantêm a limitação de starvation
documentada no [relatório IQ](./upgrade-1.11-iq-fix.md); `ignoreKey` usa o caminho antecipado.

O ensaio de persistência foi executado duas vezes: com a referência sintética construída
da master `99d9d601` (core 1.7.1 e SQLite 1.1.0) e com os pacotes antigos instalados e
resolvidos pelo manifesto local do WayAPI (core 1.7.1 e SQLite 1.0.1, versões conferidas).
Os 17 cenários passaram em cada referência, sempre em bancos temporários novos. Um título
antigo do gate cita SQLite 1.0.1 mesmo quando a referência é a cópia 1.1.0; o manifesto
local desta rodada registra a distinção. Não houve alteração ou teste no banco do consumidor.
Isso não identifica a versão efetiva em produção. Builds/tarballs locais não provam
permissões do registry ou publicação atômica de core e SQLite.
