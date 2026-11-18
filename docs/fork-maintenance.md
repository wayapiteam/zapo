# Manutenção do fork

O fork integra a base upstream `zapo-js` 1.11.0, commit
`bceb268c846763a2cd0b494da830a54aacdc3818`. Essa é a referência integrada, não uma afirmação
sobre a versão mais recente disponível. Atualize a referência ao integrar outro upstream.

Planos de execução, resultados de rodadas, cobertura e benchmarks ficam nos artefatos da
avaliação, fora do Git. Este guia registra comportamentos e comandos que precisam continuar
válidos. JSDoc, changelogs, changesets e instruções de publicação fazem parte do projeto.

## Comportamentos a preservar

| Área           | Contrato do fork                                                                                                                                                       | Proteção principal                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Entrada        | 12 handlers ativos e 4096 aguardando por geração; 4108 chunks wire; budgets separados de 64 MiB para wire/corpos preparados; pré-ready de 2048 frames/16 MiB           | Testes de WaComms e gates de fila/loopback                                         |
| Respostas IQ   | Antecipar somente result/error de uma consulta IQ pendente; reutilizar o correlacionador e decodificar uma vez; preservar contagem offline, eventos e receipts/retries | Correlação, prepared-input, coordenador e loopback com 12 consultas/4096 pendentes |
| Filtros        | Filtros raw arbitrários mantêm autoridade antes da resolução e desativam a antecipação; ignoreKey exclui IQ antes do predicado do usuário                              | Testes de filtros/ignoreKey e loopback                                             |
| Lifecycle      | Pedidos posteriores de disconnect vencem restarts anteriores; revalidar geração após I/O e antes de abrir outro comms; geração antiga não resolve consulta nova        | Testes do connection manager, geração e reconexão                                  |
| Consultas      | Timeout/rejeição de envio só removem a inscrição original; reutilizar ID não permite que conclusão antiga remova a consulta nova                                       | Query-correlation e loopback com rejeição tardia                                   |
| Persistência   | Salvar/reler loginCounter nos cinco providers; registros antigos mantêm fallback; migrações preservam chaves e isolamento por sessão                                   | Testes dos providers e gate de upgrade/rollback                                    |
| Migração MySQL | Retomar coluna de contador já criada e compatível após interrupção; rejeitar coluna incompatível                                                                       | Integração MySQL com falhas de DDL injetadas                                       |
| Phash          | Buffer expansível do upstream, sem limite por padrão; limite local somente quando explícito                                                                            | Phash-compatibility e resolução de opções                                          |
| Proxy TCP      | Dial de literal IPv6 sem colchetes; erro de URL inválida não expõe userinfo                                                                                            | Testes TCP proxy e CONNECT local                                                   |
| Pacotes        | Core e SQLite do fork usam identidades/peer do fork; CJS e ESM funcionam sem um segundo core upstream                                                                  | Gates do publisher e dos tarballs                                                  |

Esses pontos orientam a revisão do upgrade; não substituem a comparação completa do diff
do fork. Há outras customizações, inclusive no envio de mensagens e newsletters, cujos
testes também precisam permanecer verdes.

## Limites do contrato

As filas e budgets são por geração, não tetos globais de memória ou operações do processo.
Callbacks já iniciados podem concluir depois de reconectar; seus efeitos externos não são
desfeitos pelo descarte dos callbacks ainda aguardando. Cada operação precisa limitar seu I/O.

Com filtro raw arbitrário registrado, doze handlers aguardando IQ ainda podem esgotar as
vagas da fila comum. O incremento de concorrência não corrige esse ciclo de dependência.
O caminho antecipado permanece disponível com o filtro embutido ignoreKey.

Disconnect limpa estado transitório e preserva a sessão persistida. Logout/revogação e
limpeza explícita conservam seus contratos de remoção. Um caminho de banco diferente pode
criar outra identidade; preserve o caminho absoluto e o arquivo existente no consumidor.

## Integração de um novo upstream

1. Registrar a base atual e a revisão upstream escolhida; comparar especialmente transporte,
   lifecycle, correlação, phash e stores. Integrar em uma branch do fork.
2. Confrontar mudanças upstream com os contratos acima. Se o upstream satisfizer o contrato,
   preferir sua implementação e remover o patch local substituído. Preservar testes válidos,
   sem manter dois fluxos concorrentes para a mesma função.
3. Rever identidade dos pacotes, peers, lockfile e publicação. Seguir o
   [guia de release](./fork-release.md), sem publicar add-ons upstream por engano.
4. Rodar os gates com builds atuais e conferir os testes negativos. Merge sem conflito
   textual não demonstra compatibilidade de sessão ou comportamento.
5. Atualizar fixtures e referência de persistência explicitamente. O gate legado resolve
   core `@wayapiteam/zapo` e provider `@zapo-js/store-sqlite` pelo manifesto de referência;
   um consumidor já migrado ao provider scoped do fork exige adaptar essa referência/gate.
   Não carregar silenciosamente o SDK candidato como se fosse a versão antiga.
6. Revisar JSDoc e este guia quando o contrato mudar. Manter evidências de cada rodada fora
   do repositório, associadas ao SHA, versões efetivamente testadas e comandos executados.

## Validação antes de publicar

```bash
npm run build
npm run build -w packages/fake-server
npm run build -w packages/store-sqlite
npm test
npm run test:upgrade:queue
npm run test:upgrade:iq-loopback
npm run test:release
npm run test:release:package
npm run typecheck:all
npm run lint
npm run format:check
```

Para persistência cruzada, definir `ZAPO_UPGRADE_REFERENCE_MANIFEST` apontando para um
manifesto que resolva os pacotes antigos pretendidos e executar
`npm run test:upgrade:persistence`. Os fixtures usam bancos temporários. Mudanças nos outros
providers também exigem seus testes de integração com serviços de teste dedicados.

Preferir unitários de comportamento para timeout, falha de envio, cancelamento, orçamento
e liberação de recursos. Simular fronteiras de I/O, sem replicar a implementação inteira
em mocks. Manter integração com codec/Noise/SQLite reais para proteger a composição. Cobertura
de linhas ajuda a localizar lacunas, mas não substitui casos de falha nem integração.

Antes da implantação, conferir versão/processo antigos e shutdown, caminho do banco,
backup consistente e rollback. Fazer canário com sessão WhatsApp controlada, incluindo
pareamento, reinício e retomada; comparar timeouts IQ, backlog, reconexões, CPU e memória.
Testes locais não garantem aceitação do protocolo pelo WhatsApp real. Reiniciar o processo
encerra seu socket físico; preservar a sessão significa conseguir retomá-la com suas chaves.
