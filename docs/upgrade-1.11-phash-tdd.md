# Phash, falhas anteriores e regressão do upgrade

> Atualização posterior nesta mesma data: o `loginCounter` foi corrigido, e os
> 17 testes de persistência e migração passaram. As referências ao gate vermelho
> abaixo descrevem o estado anterior à correção. O bloqueio de IQ continua aberto.
> Consulte as [evidências de preservação de credenciais](./upgrade-1.11-login-counter.md).

Atualização de 14/11/2026 na branch `chore/upgrade-zapo-1.11-session-safety`. Sem mudança da dependência do WayAPI, sem rebase da branch compartilhada e sem ação em produção.

## Decisão: algoritmo upstream e limite local opcional

`phash` é o resumo criptográfico dos endereços de dispositivos usados no fanout de uma mensagem de grupo ou broadcast. O cálculo normaliza os endereços, ordena os bytes e usa um prefixo do SHA-256. Não é o número de pessoas do grupo: uma pessoa pode resolver para mais de um dispositivo, e o remetente também entra no cálculo.

Nossa implementação antiga reservava 96 bytes por endereço e crescia pela quantidade de participantes. O fork impunha 4096 entradas por padrão e permitia configurar até 16384. Isso removeu o teto original de 2048, mas continuou criando uma restrição local que podia rejeitar um fanout maior.

O upstream corrigiu a causa: dimensiona o buffer pelos bytes necessários. Reutiliza o buffer canônico até 1 MiB e faz alocações temporárias acima disso. O limite de 1 MiB é do buffer canônico retido, não da memória total: índices, ordenação e a lista de entrada também ocupam memória. A ordenação continua tendo custo proporcional ao tamanho da lista; não foi alegado ganho de CPU sem benchmark.

A solução aplicada mantém esse algoritmo e essa política de retenção. A opção do fork continua disponível como proteção explícita:

| Configuração                 | Comportamento                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| Sem `phashMaxParticipants`   | Comportamento upstream: buffers crescem e não há teto artificial de participantes.           |
| `phashMaxParticipants: 4096` | Rejeita fanouts acima de 4096 entradas, preservando a escolha explícita atual do WayAPI.     |
| Outro inteiro de 1 a 16384   | Aplica o limite local informado. A faixa de configurações explícitas do fork foi preservada. |
| Excesso de entradas          | Lança erro; não trunca destinatários e não calcula hash de uma lista parcial.                |

A opção passa a valer consistentemente em grupos e broadcasts. Antes, somente o caminho de broadcast repassava o parâmetro; grupos usavam sempre o padrão da função. Essa inconsistência já existia no fork 1.7.1. Quem configurava um limite menor para grupos passará a ter a proteção respeitada; quem informava um maior poderá usá-lo nesse caminho.

O WayAPI continua configurando 4096 explicitamente. Para aproveitar fanouts maiores nele, essa configuração precisa ser removida ou revista em uma alteração do consumidor, com seus testes e validação operacional. Ela não foi alterada nesta tarefa.

A constante exportada `WA_DEFAULT_PHASH_MAX_PARTICIPANTS` foi mantida e marcada como legado/deprecated para evitar remoção abrupta de um símbolo do fork. Ela não é mais aplicada implicitamente. JSDoc da função e da opção foi atualizado.

## Eram erros novos?

| Falha observada                                                     | Origem confirmada                                                                                                                           | Estado desta atualização                                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Dois testes de newsletters esperavam `fetch_pinned_messages: false` | Já falhavam no fork 1.7.1; o código existente enviava `true`.                                                                               | Expectativas alinhadas ao comportamento já implementado. Não houve mudança de stanza ou query em runtime. |
| Dois testes upstream com 9000 e 24000 entradas eram rejeitados      | Incompatibilidade da resolução provisória do merge, que conservava o teto antigo sobre o novo buffer. O algoritmo upstream não era a causa. | Resolvidos com o teto apenas opcional. Os testes upstream originais foram mantidos.                       |
| Configuração de limite ignorada em grupos                           | Bug preexistente do fork.                                                                                                                   | Resolvido e coberto pelo envio público do coordenador.                                                    |
| Oito handlers aguardando IQ bloqueiam as próprias respostas         | Reproduzível no fork e no candidato; não foi causado pelo upgrade.                                                                          | Continua aberto no gate de fila.                                                                          |
| `loginCounter` some ao reabrir SQLite                               | Omissão de persistência presente no store 1.0.1 instalado e no 1.3.0 candidato. Não foi observada perda das chaves.                         | Continua aberto no gate de persistência.                                                                  |

Descobrir um bug com um teste novo não significa que a atualização o introduziu. A caracterização isolada da base antiga foi usada para fazer essa distinção.

## TDD e cobertura ampliada

Antes de alterar a implementação, foram escritos testes para a política desejada e para preservar os contratos já existentes. O recorte ficou vermelho com seis falhas: padrão implícito antigo, limite ignorado em grupos e fanouts grandes rejeitados em grupos, broadcasts e função de hash. Depois da alteração, o mesmo recorte ampliado passou com 148 aprovações.

Os contratos foram registrados no commit separado `f1f5041`, antes do commit de implementação, para permitir revisar a fase vermelha.

Foram acrescentados 24 cenários ao core:

- Onze de compatibilidade de phash: canonicalização PN/LID, duplicatas, ordem e preservação do array do chamador, crescimento/reutilização após listas menores, limite exato, excesso por uma entrada e limites explícitos inválidos, inclusive com lista vazia.
- Seis de envio pelo coordenador, em grupos e broadcasts: quantidade de dispositivos mais remetente, rejeição antes da publicação, aceitação no limite e 5000 dispositivos sem limite configurado. Os dados de fanout/encriptação são controlados; o cálculo de phash e o caminho de construção/publicação do node são reais.
- Sete de publicação/NACK: categorias de rejeição, parada no número de tentativas configurado, retry bem-sucedido e preservação dos diagnósticos no logger da operação.

Os onze testes de compatibilidade de phash e os sete de NACK também foram executados no checkout isolado do fork 1.7.1. Essa suíte antiga ampliada teve 1158 aprovações, as mesmas duas falhas antigas de newsletters e um skip. A política de envio foi caracterizada separadamente na base antiga e confirmou o limite ignorado em grupos.

Os testes upstream de 3000, 9000 e 24000 entradas, alternância entre tamanhos e alocação temporária foram aproveitados integralmente. O esperado não foi reduzido para caber no limite do fork.

### Resultado do core integrado

- 1374 testes passaram, zero falhas e um skip, de 1375 cenários.
- O recorte específico de 148 testes passou antes da execução completa.
- Build CJS/ESM/tipos, lint e formatação foram verificados. O typecheck de core/exemplos/benchmarks foi seguido da matriz de pacotes com concorrência limitada.
- A medição c8 usou o mesmo recorte de arquivos e exclusões da auditoria anterior, sem agregar testes externos de upgrade.

| Recorte                           | Linhas antes | Linhas depois | Ramos antes | Ramos depois |
| --------------------------------- | -----------: | ------------: | ----------: | -----------: |
| Core total                        |       84,19% |        84,50% |      79,99% |       80,08% |
| `phash.ts`                        |       90,55% |        94,89% |      84,48% |       90,76% |
| `WaMessageClient.ts`              |       66,59% |        73,60% |      61,29% |       74,68% |
| `WaMessageDispatchCoordinator.ts` |       42,26% |        49,55% |      70,50% |       71,19% |

Cobertura global não prova todos os comportamentos novos do upstream. Estes testes se concentram na integração e nas customizações discutidas; as suites específicas do upstream continuam cobrindo pareamento, socket, histórico e outras features. Não houve validação com WhatsApp real nesta atualização, e os bundles `wa-web`/`wa-mob` seguem ausentes.

## O que foi revertido no link preview

Os commits `ed78e18` e `60b824e` adicionaram uma forma própria de habilitar previews em newsletters e uma substituição do uploader de miniaturas por upload para CDN pública. Foram revertidos por `818f77e` e `9ddfe32`.

Isso não significa que os previews atuais devem ser removidos. O fluxo atualmente implementado no upstream/fork continua presente e seus testes de newsletter/link preview continuam executando na suíte. Não foi restaurado o uploader customizado nem reaplicados commits já revertidos.

## Limites da liberação

O core verde elimina as quatro falhas anteriores da integração, mas não libera produção: o gate de fila e o gate de `loginCounter` continuam vermelhos. Também é necessário confirmar a versão carregada em produção, preservar o caminho absoluto de `db.sqlite` e validar a retomada de uma sessão de teste real em uma máquina.

A comparação de 194 testes de lifecycle do WayAPI, registrada na auditoria de 07/11, não foi repetida nesta rodada. A dependência do consumidor não foi modificada. Os testes adicionais de upgrade continuam usando somente bancos sintéticos. Uma execução concorrente à matriz de compilação excedeu o prazo de um subprocesso de releitura; a repetição sem essa carga manteve os timeouts originais e voltou a dez aprovações e à única falha conhecida de `loginCounter`. O teste de fila manteve uma aprovação e a falha conhecida de respostas IQ bloqueadas.
