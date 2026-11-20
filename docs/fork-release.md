# Publicação dos pacotes do fork

O repositório `wayapiteam/zapo` contém os dois pacotes consumidos nesta integração:

| Diretório               | Pacote                          | Registry                     |
| ----------------------- | ------------------------------- | ---------------------------- |
| Raiz                    | `@wayapiteam/zapo`              | `https://npm.pkg.github.com` |
| `packages/store-sqlite` | `@wayapiteam/zapo-store-sqlite` | `https://npm.pkg.github.com` |

O provider declara o core do fork como peer e usa `@wayapiteam/zapo` nos imports
de runtime e tipos. Os demais add-ons mantêm seus nomes upstream para o workspace,
mas não são publicados pelo workflow do fork. Não é necessário outro repositório.

## Workflow

Uma tag `v*` ou execução manual inicia `.github/workflows/release.yml`. O workflow
compila o core e o SQLite e executa `scripts/release/publish-fork-packages.cjs` com
`GITHUB_TOKEN` e permissão `packages: write`. O script valida os dois manifests
antes de publicar, consulta cada nome completo e versão no GitHub Packages e pula
versões já existentes. Somente `E404` permite publicar uma versão ausente; falhas
de autenticação, permissão, rede ou respostas inesperadas interrompem a execução.
É possível repetir uma release parcial sem republicar o pacote já entregue.

As versões são lidas dos manifests, não inferidas da tag nem sobrescritas durante
o publish. Antes de criar a tag, confira as versões e os changesets que pertencem
à release. O comando manual `npm run release:publish` usa a mesma seleção de dois
pacotes. Nenhum comando de teste deve executar publicação real.

Os campos `repository` ligam os dois pacotes a `wayapiteam/zapo`. No primeiro
publish, confira a visibilidade e o acesso do consumidor no GitHub Packages;
pacotes novos são privados por padrão. O token do consumidor precisa de leitura
dos dois pacotes. Workflows de outro repositório precisam de acesso concedido ao
pacote para usar seu `GITHUB_TOKEN`. As configurações e credenciais já usadas para
o core precisam autorizar também o novo provider; não grave tokens no repositório.

## Consumidor

Configure o scope `@wayapiteam` para o GitHub Packages e autentique o gerenciador
de pacotes pelo mecanismo já usado no ambiente:

```ini
@wayapiteam:registry=https://npm.pkg.github.com
```

Instale as versões efetivamente publicadas do core e do provider. No WayAPI,
centralize as versões no catalog, regenere o lockfile com pnpm e ajuste o import
do provider para `@wayapiteam/zapo-store-sqlite`. O provider continua exportando
`createSqliteStore` e os mesmos contratos. Preserve o caminho e o arquivo de
sessões existentes. A inicialização do domínio auth aplica a migração nullable
`login_counter`; não há SQL manual no PostgreSQL do WayAPI.

## Validação de empacotamento

```bash
npm run build
npm run build -w packages/store-sqlite
npm run test:release
npm run test:release:package
```

O primeiro gate verifica nomes scoped, retomada parcial e rejeição de falhas de
registry ou manifests upstream. O segundo cria tarballs reais, instala os dois
em um diretório temporário sem scripts de instalação e verifica CJS/ESM,
ausência de um core `zapo-js` separado, reabertura de auth e persistência de
`loginCounter` com o driver `node:sqlite`. O fixture remove apenas seus arquivos.

O CI executa os dois gates. Estes testes não publicam pacotes nem comprovam
permissões no registry, aceitação de sessão pelo WhatsApp real ou segurança de
restart em produção. O canário e a validação de rollback continuam descritos em
[guia de manutenção](./fork-maintenance.md).
