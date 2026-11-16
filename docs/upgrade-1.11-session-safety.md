# Upgrade 1.11.0: auditoria de sessões e regressões

> Atualização posterior de 15/11/2026: a correção IQ foi implementada e os gates locais
> passaram. Consulte o [relatório atual](./upgrade-1.11-iq-fix.md), incluindo custos,
> filtros raw e validação real ainda pendente. Os resultados abaixo são históricos.

> Atualização de 14/11/2026: o algoritmo upstream foi preservado com limite local
> opcional, e as quatro falhas do core descritas nesta auditoria foram resolvidas.
> O `loginCounter` foi corrigido nos cinco providers, e o gate de persistência
> ampliado passou com 17 casos. O gate de fila continua aberto. Consulte as
> evidências de [phash e TDD](./upgrade-1.11-phash-tdd.md) e de
> [preservação de credenciais na migração](./upgrade-1.11-login-counter.md).

Avaliação de 07/11/2026. Branch local: `chore/upgrade-zapo-1.11-session-safety`.

O upgrade continua em rascunho. Não há evidência de apagamento de credenciais no fluxo normal ensaiado, mas os gates de regressão ainda estão vermelhos. Esta branch não está pronta para publicação ou implantação.

## Escopo fixado

- Fork remoto de referência: `99d9d6015718bee26d4830a39be2f9a46f772996`, versão 1.7.1.
- Upstream: `bceb268c846763a2cd0b494da830a54aacdc3818`, versão 1.11.0.
- WayAPI local: `33d7a8a8251cef8e90a60a5ac3ce33c111f42f4c`, com alterações locais preexistentes preservadas. A versão efetivamente carregada em produção é desconhecida pelo usuário.
- SQLite instalado no WayAPI: 1.0.1; candidato: 1.3.0.
- Node local: 24.15.0. Nenhuma credencial real ou banco de produção foi aberto.

A integração preserva a identidade do fork, diagnósticos de NACK, opções de publicação em newsletters e, provisoriamente, seus limites de phash. Não implementa a correção restante da fila nem escolhe uma nova política de limites.

## Cobertura medida

Cobertura de execução, não apenas contagem de testes:

| Recorte                                     | Linhas |  Ramos |
| ------------------------------------------- | -----: | -----: |
| Core candidato, suíte existente, sem flows  | 84,19% | 79,99% |
| `credentials-flow.ts`                       | 89,97% | 93,10% |
| `WaClient.ts`                               | 55,00% | 59,57% |
| `WaConnectionManager.ts`                    | 63,71% | 72,13% |
| `WaStreamControlCoordinator.ts`             | 84,23% | 78,94% |
| `WaComms.ts`                                | 65,32% | 76,00% |
| `WaWebSocket.ts`                            | 76,60% | 75,55% |
| WayAPI: seis arquivos críticos selecionados | 87,51% | 76,66% |

O último recorte inclui o adapter Zapo, utils, eventos, classificador, server e bootstrap. Não representa a cobertura global do WayAPI. A medição do core não agrega a suíte do WayAPI ou os novos testes externos de upgrade. Nessa medição isolada, `WaClient.disconnect()` teve zero execuções: a porcentagem global não era prova de preservação no shutdown.

A suíte existente vai além do caminho feliz. Há cenários de sockets substituídos, mensagens tardias, handshake invalidado, retomadas simultâneas, falha de persistência, cache com TTL, pareamento expirado, cancelamento de connect, rejeição de parâmetros conflitantes, falha de drain, exclusões do bootstrap e SIGINT/SIGTERM em processos filhos. Muitos desses testes controlam transporte ou `connect()`; não validam uma sessão aceita pelo WhatsApp.

## Comparação do consumidor

Foram executados os mesmos sete arquivos de lifecycle do WayAPI, com PostgreSQL 18 temporário e exclusivo da tarefa:

| SDK / store selecionados             | Resultado           |
| ------------------------------------ | ------------------- |
| Fork instalado 1.7.1 / SQLite 1.0.1  | 194 testes passaram |
| Core candidato 1.11.0 / SQLite 1.0.1 | 194 testes passaram |
| Core candidato 1.11.0 / SQLite 1.3.0 | 194 testes passaram |

Os aliases foram aplicados por projeto do Vitest; um setup conferiu em runtime um método exclusivo do core novo, evitando um resultado verde com o SDK antigo. Os subprocessos receberam um hook de resolução para o SDK/store candidato. A primeira tentativa de substituição não atendia essa condição e foi descartada da evidência comparativa.

Os processos de sinal existentes cobrem os estados `connected` e `connecting`, conferem o status durável e reabrem o SQLite para comparar a identidade. Conexões reais ao WhatsApp continuam fora desse ensaio.

## Novos gates reproduzíveis

Foram adicionados `scripts/upgrade/credential-upgrade.test.cjs`, seu worker e o ensaio da fila. Eles usam APIs reais de auth/store, processos separados e apenas arquivos temporários gerados pelo próprio teste. O worker recusa caminhos fora do padrão de diretórios sintéticos da suíte.

### Persistência: dez casos verdes e um vermelho

Os casos verdes verificam:

1. Pacote realmente instalado 1.7.1 e store 1.0.1 escrevendo duas sessões; core novo lendo com o store antigo; rollback relendo as mesmas chaves.
2. Migrações do SQLite 1.3.0, releitura pela versão antiga e nova, sem perder autenticação ou ratchets.
3. Troca para `node:sqlite` e retorno ao driver nativo antigo.
4. SIGINT e SIGTERM no processo candidato, com releitura pelas versões nova e antiga.
5. Falha de leitura propagada, sem conversão em credenciais novas.
6. SIGKILL durante um DELETE não confirmado, com rollback da transação preservando as duas sessões.
7. Caminho de banco errado criando uma identidade não registrada, enquanto o banco correto permanece intacto. É uma demonstração de risco operacional, não uma proteção automática do SDK.
8. Limpeza explícita de autenticação continuando funcional e limitada à sessão correspondente.
9. Arquivo SQLite corrompido sendo rejeitado sem ser substituído por credenciais novas.

O teste vermelho exige persistir `loginCounter`, definido no contrato do core. Ao salvar `42`, destruir e reabrir o store candidato, o campo voltou ausente. O store 1.0.1 instalado também o omite. As chaves verificadas não foram apagadas; a lacuna é um campo de estado que os round trips antigos não checavam. Não há evidência de que essa omissão isolada cause logout em massa. É necessário resolver esse contrato antes de tratar o round trip como completo.

A comparação cobre chaves Noise, identidade, signed prekey, ADV, identidade assinada, routing info e chave estática do servidor. Também confere prekey, identidade remota, ratchet Signal, sender key e isolamento entre sessões. Os arquivos de teste contêm somente credenciais sintéticas e são removidos ao final.

### Fila: um caso verde e um vermelho

- Verde: oito handlers ativos, fila com 4096 frames e cinco excedentes produzem um único fechamento/reabertura.
- Vermelho: oito handlers aguardando IQ ocupam os slots que as próprias respostas precisam para avançar. O gate exige oito conclusões antes do timeout; o candidato concluiu zero. Os oito pedidos terminam em timeout.

As asserções da fila descrevem o comportamento desejado; o helper não exige que o bug continue existindo. Esse é um teste de regressão para dirigir uma correção posterior, não um ensaio que fica verde por confirmar o bloqueio.

### Como executar

Construa o candidato e seu provider:

```bash
npm ci --ignore-scripts
npm rebuild better-sqlite3
npm run build
npm run build -w packages/store-sqlite
npm run build -w packages/fake-server
```

A referência precisa continuar resolvendo o fork 1.7.1 e o SQLite 1.0.1, por exemplo em um checkout isolado do WayAPI anterior à troca da dependência:

```bash
ZAPO_UPGRADE_REFERENCE_MANIFEST=/caminho/wayapi/packages/shared/package.json npm run test:upgrade:persistence
npm run test:upgrade:queue
```

`ZAPO_UPGRADE_CANDIDATE_ROOT` permite apontar para outro build candidato. Os comandos falham enquanto as regressões descritas estiverem abertas. Os novos arquivos passam pelo ESLint e pelo Prettier; não se deve alterar suas expectativas para aceitar perda de campos ou timeout.

## Banco e elegibilidade são contratos distintos

O fluxo normal `WaClient.disconnect()` drena o cliente e emite `client_disconnected` com `isLogout: false`. `BaseSqliteStore.destroy()` fecha conexões; não exclui as linhas de autenticação. A diferença de migrações entre o fork remoto e o upstream adiciona um campo de contato, sem migração destrutiva de auth. O build limpa `dist`, não o banco de sessões.

A limpeza explícita existe e deve continuar existindo: logout efetivo, revogação e eventos terminais podem limpar autenticação. Desativá-la indiscriminadamente para preservar credenciais alteraria o contrato do produto.

No WayAPI, o shutdown correto sinaliza `shutdownRequested` antes de chamar `disconnect()`, aguarda tarefas e escritas e preserva o status elegível. O bootstrap seleciona apenas `connected` ou `connecting`, da própria máquina e não excluídas. Portanto, mesmo com SQLite intacto, gravar `disconnected` no encerramento pode deixar uma instância fora da retomada.

O repositório do WayAPI documenta um incidente anterior com exatamente esse encadeamento. Como o commit carregado em produção é desconhecido, não foi comprovada a primeira transição a partir daquele processo. Build novo em disco não muda o shutdown que a versão antiga já carregou em memória.

Outro risco confirmado: o WayAPI usa `path.resolve('./db.sqlite')`, e a configuração PM2 não fixa `cwd`. Alterar o diretório efetivo pode apontar para um arquivo novo e provocar novo pareamento sem apagar o arquivo antigo. O teste negativo reproduz esse comportamento.

## Pendências identificadas em 07/11/2026 (histórico)

- Resolver o `loginCounter` e a fila; deixar os novos gates verdes.
- Resolver as quatro falhas conhecidas da suíte core integrada: duas expectativas antigas de newsletter, já presentes no fork, e dois casos phash incompatíveis com os limites preservados. A suíte existente teve 1346 aprovações, quatro falhas e um skip.
- Resolver a política de phash e suas diferenças entre grupos e broadcasts; não remover opções usadas pelo consumidor sem migração.
- Conferir o commit, runtime e comportamento de shutdown realmente carregados em produção.
- Validar uma sessão de teste aceita pelo WhatsApp, com reinício e retomada, além de pareamento/reconexão. Credenciais presentes no SQLite não provam aceitação pelo servidor.
- Verificar o caminho absoluto do banco e backup SQLite consistente, incluindo WAL; não copiar apenas o arquivo de um banco aberto.
- Fazer implantação em uma máquina e comparar a lista de instâncias esperadas com as que voltaram, falharam ou pediram pareamento. PM2 online e log de startup concluído não bastam.

Não foram exercitados disco cheio, todos os erros de sistema de arquivos, todos os bancos opcionais, uma frota com carga real ou o encerramento de um transporte autenticado real. Os testes não constituem garantia universal de ausência de regressão. Eles fornecem contratos executáveis e evidência local, inclusive dois problemas que agora impedem uma liberação precipitada.

## Estado da tarefa

Tudo foi preparado em worktree e branch separados. A `master` original e a dependência do WayAPI permanecem intactas. Nenhum push, publicação ou ação em produção foi feito. Os relatórios detalhados e os logs da auditoria ficam nos artefatos desta tarefa.
