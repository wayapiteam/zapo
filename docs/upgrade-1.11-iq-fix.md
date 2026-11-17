# IQ: implementação, regressão e manutenção do fork

> Atualização de 17/11/2026: a revisão independente revelou também falhas de lifecycle,
> envio tardio com ID reutilizado e proxy. As correções TDD e os limites desta nova rodada
> estão no [relatório da revisão](./upgrade-1.11-review-fixes.md). Os números abaixo são da
> rodada original de 15/11/2026.

15/11/2026. Branch: `chore/upgrade-zapo-1.11-session-safety`. Base da implementação:
`4ab4561093bc3c7b673da5bae9e79070e6cb6759`. O upstream 1.11.0 já estava integrado.

Oito handlers podem agora aguardar consultas IQ sem bloquear as próprias respostas. O nó
é decodificado uma vez no caminho serial de entrada, antes da fila de handlers. Uma resposta
IQ elegível resolve a consulta pelo correlacionador existente. Os outros nós são encaminhados
à fila normal, sem aguardar a conclusão dos handlers na fase de leitura.

Esta implementação é uma alteração interna de despacho. Não adiciona tags, namespaces ou
fluxos de protocolo, não muda stores/migrações e não chama limpeza de credenciais. Os bundles
`wa-web/` e `wa-mob/` não estão disponíveis neste checkout. A validação local usa decisões já
codificadas em `src/`, fixtures sintéticos e transporte WebSocket/Noise em loopback.

## Contrato implementado

```text
WebSocket -> Noise serial -> decode único -> conferir geração
                                           |
                             IQ result/error pendente e elegível?
                                 sim: resolver consulta existente
                                 não: fila normal limitada -> handler
```

- O pedido original precisa ser IQ e a resposta precisa ser IQ `result` ou `error` com ID
  pendente. O tag do pedido fica no mesmo `pendingQueries`; não há outro mapa ou parser.
- O resolver existente remove a pendência e cancela seu timer. Payloads de erro continuam
  sendo entregues para a validação de negócio existente; não viram sucesso artificial.
- Requests, IDs ausentes/desconhecidos, duplicatas consumidas, acks e receipts seguem o
  dispatcher normal. `retry` e `enc_rekey_retry` preservam o handler antes da correlação.
- IQ antecipado com atributo `offline` preserva a contabilidade antes de resolver a consulta.
- `frame_in`, `node_in` e `decode_error` mantêm uma emissão por ocorrência. A observação do
  decode ocorre antes da admissão do handler; a conclusão de handlers concorrentes nunca
  teve ordem global garantida. Erros de handler continuam chegando a `debug_client_error`.
- A preparação não consulta banco nem aguarda callbacks de negócio. Decriptação, preparação
  e finalização do handshake compartilham a entrada serial, preservando a ordem do Noise.

### Filtros e superfície raw

Qualquer filtro arbitrário registrado por `lowlevel.registerIncomingStanzaFilter` desabilita
a antecipação enquanto estiver registrado. O filtro mantém o poder de aceitar, descartar ou
lançar erro antes do dispatcher. Nesse modo, oito handlers aguardando IQ ainda podem causar
starvation. Isso é uma limitação explícita de compatibilidade, não uma garantia de progresso.

O `ignoreKey` já exclui IQ antes de invocar o predicado do usuário, portanto é registrado
internamente como seguro para essa antecipação. Seus modos descritor e predicado são cobertos.
Registro e remoção de filtros são consultados no momento da triagem. Não há opção nova na
API lowlevel pública para declarar arbitrariamente que um filtro é seguro.

`WaComms.startComms(handler, inflateFrame?, prepareStanza?)` mantém os dois primeiros
argumentos compatíveis. Sem o terceiro argumento, usa o callback raw tradicional. O novo
preparador recebe frame, predicado de geração e callback de tamanho expandido; retorna
`null` ou um callback de trabalho normal. Quem usa esse hook deve respeitar seu JSDoc:
verificar geração após trabalho assíncrono, reportar bytes expandidos e não aguardar negócio.

### Recursos e reconexão

| Estrutura por geração                           | Limite                                               |
| ----------------------------------------------- | ---------------------------------------------------- |
| Wire admitido, em processamento ou esperando    | 4104 chunks e 64 MiB                                 |
| Handlers normais                                | 8 ativos e 4096 esperando                            |
| Bytes de corpo retidos por callbacks preparados | 64 MiB, incluindo ativos e esperando                 |
| Frames pré-ready                                | 2048 frames e 16 MiB, limites anteriores preservados |

O limite de callbacks preparados usa o maior tamanho entre frame recebido e corpo expandido,
reportado pelo decoder após descompressão. A reserva é liberada no término ou cancelamento.
O limite não mede overhead dos objetos JavaScript, RSS, buffers internos do sistema ou a
alocação transitória de um único inflate. Não é uma defesa completa contra input ilimitado.
O caminho raw sem preparador preserva sua política anterior de bytes dos handlers.

Excesso real dispara a retomada única já existente, com tratamento explícito da rejeição.
A correção do bloqueio não usa essa retomada: os ensaios de saturação passam sem reconectar.

Ao substituir uma conexão, a fila pendente é rejeitada e uma nova fila é criada. Isso evita
que oito callbacks antigos bloqueados e 4096 esperando ocupem as vagas da conexão nova.
Geração é verificada após Noise, inflate e decode e antes de executar callbacks pendentes.
Uma resposta antiga não pode resolver uma consulta nova com o mesmo ID.

Callbacks já iniciados não podem ser desfeitos. Seus erros tardios permanecem visíveis,
mas suas operações precisam ter limites próprios. Oito vagas e budgets são por geração:
callbacks antigos podem continuar após reconexão, portanto esses números não são um limite
global de execuções ou memória ao longo de reconexões sucessivas.

## TDD e evidências

Os commits `f3f6c07` e `b3b7dd4` acrescentaram testes antes da implementação; o plano foi salvo
em `4ab4561`. O baseline tinha cinco falhas no gate controlado e duas no loopback original.
Antes dos ajustes de revisão, novos ensaios também reproduziram fila antiga sem capacidade,
ordenação concorrente na saída do handshake e perda de observabilidade de erro tardio.

Os sete casos controlados preservam as expectativas: oito consultas, ordem inversa,
result/error, IDs inválidos/duplicados, backlog de 4096 e uma resposta realmente omitida.
O timeout intencional continua existindo apenas para a resposta ausente.

O loopback foi ampliado para quinze cenários, incluindo compressão, filtros raw,
`ignoreKey`, drain gerenciado, erro de handler e troca real de conexão com ID reutilizado.
O drain usa contabilidade gerenciada explicitamente no fixture; handlers raw de extensão
não são automaticamente registrados nessa contabilidade. O teste com conexão antiga
retém um decode, reconecta via Noise, reutiliza o ID e verifica o fingerprint das chaves.

O baseline pré-fix também foi reconstruído e recebeu a matriz ampliada de treze casos
disponível naquele momento: seis passaram e sete falharam. Esses vermelhos incluem
variações do mesmo bloqueio. Não significam sete bugs independentes do upstream.

Os filtros raw ativos são exercitados com sete handlers, verificando seu contrato; esses
casos não comprovam progresso com oito. O caso que remove o filtro antes do despacho usa oito.
Os ensaios que exigem progresso com oito mantêm a conexão aberta, uma autenticação e zero
fechamentos durante as consultas. O drain fecha deliberadamente depois de concluir o trabalho.

### Rodada final

| Verificação                            | Resultado                                    |
| -------------------------------------- | -------------------------------------------- |
| Core, suíte completa sem flows         | 1410 passaram, um skip anterior, zero falhas |
| Gate controlado de fila                | 7 passaram                                   |
| WebSocket/Noise local                  | 15 passaram                                  |
| Fake-server completo                   | 217 passaram                                 |
| Persistência cruzada com versão antiga | 17 passaram                                  |
| WayAPI, sete arquivos de lifecycle     | 198 passaram                                 |
| Build core CJS/ESM/types               | Passou                                       |
| Typecheck core, exemplos e benchmarks  | Passou                                       |
| Typecheck pacotes com concorrência 2   | 11 pacotes passaram                          |
| Lint completo, estrutura e format      | Passaram                                     |

O gate de persistência leu o manifesto de referência do WayAPI com o fork antigo 1.7.1 e
SQLite antigo 1.0.1. Foram verificados fingerprints das chaves, metadados e duas sessões,
migração, restart, SIGTERM, rollback ao leitor antigo, falha de leitura, caminho incorreto,
banco corrompido e SIGKILL durante delete sem commit. Limpeza explícita continua eficaz e
restrita à sessão. O caminho incorreto continua criando outra identidade; o upgrade não
conserta configuração de caminho nem prova que a produção usa o caminho esperado.

A matriz WayAPI usou core e SQLite candidatos em runtime, incluindo subprocessos, com um
PostgreSQL 18 temporário dedicado ao ensaio. Nenhuma dependência do consumidor foi editada.
Passaram os cenários de shutdown SIGINT/SIGTERM com estados connected/connecting e de
retomada no startup. Isso não identifica a versão que está rodando em produção.

A cobertura foi medida com c8 sobre a suíte completa do core, no mesmo recorte de quatro
arquivos da rodada TDD. Não representa cobertura global nem inclui os gates que usam dist.

| Arquivo                 | Linhas antes/depois | Ramos antes/depois |
| ----------------------- | ------------------- | ------------------ |
| `WaComms.ts`            | 65,32% / 73,30%     | 76,00% / 75,77%    |
| `WaNodeOrchestrator.ts` | 94,39% / 94,95%     | 82,69% / 85,24%    |
| `WaNodeTransport.ts`    | 98,86% / 99,06%     | 82,60% / 88,57%    |
| `BoundedTaskQueue.ts`   | 98,79% / 98,97%     | 93,54% / 93,93%    |

O percentual de ramos de WaComms não cresceu: o arquivo ganhou ramos e ainda há caminhos
sem cobertura. Não declarar 100% ou ausência de regressão a partir dessas porcentagens.
Os gates combinados demonstram os comportamentos de interesse além da cobertura de linhas.

Logs, JSON de benchmark, cobertura e revisões estáticas estão no diretório de evidências
`iq-fix-2026-11-15`, sob a avaliação local `avaliacao-upgrade-zapo`. O manifesto local de
verificação registra checksums dos logs e SHAs para associar resultados ao código avaliado.
As revisões Luna/Terra foram estáticas, não execuções independentes das suítes. Elas motivaram
os testes e ajustes de fila antiga, contagem offline, ordem pós-handshake e erro tardio.
A matriz combinada de conexão antiga/ID reutilizado e a asserção de que o predicado
ignoreKey não recebe IQ também foram acrescentadas.

## Medição de custo

Script: `scripts/upgrade/iq-dispatch-bench.cjs`, executado com `node --expose-gc` em Node
24.15.0. Compara o build de `4ab4561` ao candidato, em duas execuções alternadas por revisão,
sem compiladores ou suítes concorrentes. Cada execução tem duas amostras de aquecimento e
oito medidas de 2000 frames normais. Codec e filas são reais; Noise/rede são sintéticos.

| Medida                                      | Antes, duas execuções | Depois, duas execuções |
| ------------------------------------------- | --------------------- | ---------------------- |
| Mediana para 2000 frames                    | 3,210 / 2,933 ms      | 3,663 / 3,621 ms       |
| CPU por amostra de 2000                     | 8,024 / 8,079 ms      | 8,617 / 7,254 ms       |
| Pico de heap amostrado                      | 25,95 / 26,06 MB      | 26,10 / 26,10 MB       |
| Max RSS do processo                         | 96.928 / 96.976 KiB   | 100.592 / 100.336 KiB  |
| Mediana resposta IQ até término, 8 handlers | 99,865 / 99,804 ms    | 0,070 / 0,071 ms       |
| Consultas concluídas/expiradas por execução | 35 / 5                | 40 / 0                 |

A preparação acrescentou aproximadamente 0,45 a 0,69 ms por 2000 frames nesse microbenchmark
(14% a 23% de tempo de parede). CPU variou nos dois sentidos; RSS cresceu aproximadamente
3,3 a 3,6 MiB. Não afirmar ausência de custo, alocações totais ou melhoria de throughput em
produção com esses dados. O benefício demonstrado é o progresso de IQ antes do timeout de
100 ms do ensaio, mantendo trabalho normal em progresso e sem retomadas. Heap amostrado
não é pico contínuo de alocação, e max RSS inclui runtime/JIT/harness, não só as filas.

## Arquivos e manutenção upstream

| Área                                     | Patch local que precisa ser confrontado com futuras atualizações            |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `WaComms` e tipos de transporte          | Hook opcional, entrada serial, budgets, troca de fila por geração           |
| `BoundedTaskQueue`                       | `clearPending(reason)` rejeita só trabalhos aguardando e retorna quantidade |
| Decoder e `WaNodeTransport`              | Decode único, metadata de tamanho e checkpoints de geração                  |
| `WaNodeOrchestrator`                     | Tag do pedido no registro existente e reconhecimento de IQ pendente         |
| `WaIncomingNodeCoordinator`              | Política de filtros, contagem offline e resolução antes da fila             |
| `WaClient`, factory e connection manager | Ligação do preparador, erros e recriação de conexão                         |
| JSDoc lowlevel e changelog               | Contratos públicos e limitação de filtros raw                               |
| Scripts/testes/CI                        | Contratos de correlação, backlog, transporte real e lifecycle               |

O job `test-fake-server` do CI agora exige também os dois gates IQ após construir core e
fake-server. O `all-checks` já depende desse job. A persistência cruzada e a matriz WayAPI
dependem de referências externas, portanto sua execução local permanece registrada à parte.

Para um upgrade futuro, registrar SHAs, integrar em branch do fork e executar todos os
gates abaixo. Se a solução upstream satisfizer os contratos, preferir o upstream e remover
o patch substituído, mantendo os testes válidos. Não manter dois resolvedores concorrentes.
Continuam separados os patches de `phash`, identidade/publicação do fork e `loginCounter`;
esta correção não deve escondê-los em uma grande reescrita de transporte.

```bash
npm run build
npm run build -w packages/fake-server
npm test
npm run test:upgrade:queue
npm run test:upgrade:iq-loopback
npm run test:upgrade:persistence
npm run typecheck:all
npm run lint
npm run format:check
```

O gate de persistência precisa do manifesto antigo e dependências de referência descritos
em [login counter](./upgrade-1.11-login-counter.md). Em máquinas com pouca RAM, executar
typecheck/build dos pacotes com concorrência limitada. O plano histórico e a sequência de
decisões estão em [plano IQ](./upgrade-1.11-iq-dispatch-plan.md).

## Condições para implantação

Esta rodada não faz deploy, publicação, merge na master nem alterações no upstream.
Preservação local de credenciais e testes verdes não garantem ausência de falhas em produção.
Não houve WhatsApp real. Antes de liberar o upgrade, conferir a versão antiga em execução,
seu shutdown, caminho absoluto do banco e inventário das sessões, e fazer canário com sessão
controlada e backup consistente. Validar pareamento, restart, retomada e rollback reais.
Reiniciar um processo encerra seu socket físico; o objetivo é preservar as credenciais e
retomar sem novo pareamento. Comparar timeouts IQ, overflow e reconexões com o baseline.
