# Automação Comunidade 1.0.0

Aplicativo independente para Windows 10/11 de 64 bits. Organiza participantes de grupos e envia convites privados **somente aos contatos com autorização registrada**. Não utiliza o banco, a sessão nem as configurações do Kenned Code Disparos.

## Instalar e conectar

1. Abra `Automacao-Comunidade-Setup-1.0.0-x64.exe` e mantenha uma pasta exclusiva para o aplicativo. O atalho da área de trabalho é opcional.
2. Em **Configurações**, leia e confirme a identificação da integração não oficial. Clique em **Conectar** e, se solicitado, leia o QR Code em **WhatsApp → Dispositivos conectados → Conectar dispositivo**.
3. Em **Grupos e participantes**, sincronize os grupos reais e clique em **Atualizar participantes** no grupo escolhido.
4. Em **Contatos**, selecione os destinatários e registre como autorizaram os convites. Participar do grupo não autoriza mensagens privadas. Contatos sem telefone confiável permanecem indisponíveis para envio.
5. Crie uma mensagem em **Modelos**, ou prepare diretamente uma campanha. Use `{nome}` e `{link_comunidade}` se desejar.
6. Na campanha, configure mensagem, link, contatos ou grupos de origem, intervalo, limites, dias e horários. **Salvar cria um rascunho.** Confira a prévia por destinatário e confirme o início.

O botão **PARAR TODOS OS ENVIOS** bloqueia novas submissões e cancela as tarefas pendentes. Um pedido já submetido ao WhatsApp pode não ser cancelável; seu resultado será registrado. Retome as automações explicitamente antes de iniciar outra execução.

## Intervalos, modos e resultados

- **Tempo entre envios para contatos:** valor em segundos ou minutos, próprio de cada campanha. Com 30 segundos, o próximo contato aguarda 30 segundos após o término da tentativa anterior. Alterações durante a execução valem para os próximos contatos.
- Existe um piso interno de 3 segundos; ele **não representa um limite oficial ou garantia de segurança do WhatsApp**. Restrições informadas pela integração continuam sendo respeitadas. Utilize intervalos e limites adequados à sua operação autorizada.
- O painel mostra o próximo horário e a contagem regressiva. Pausa, reconexão, suspensão ou reinício impõem novamente o intervalo completo, sem enviar tarefas acumuladas em rajada.
- **Somente novos**, padrão: ignora contatos com envio aceito, entregue ou incerto em qualquer campanha anterior, mesmo após mudar nome/texto ou limpar o histórico visual.
- **Enviar novamente para todos os registrados:** exige nova prévia e confirmação explícita. Bloqueios, silêncio e pedidos para não receber continuam valendo. Envios incertos exigem revisão e confirmação específica do risco de duplicação.
- **Aceito** depende da confirmação disponível da integração; não significa entregue ou lido. **Entregue** exige recibo posterior. Uma tentativa sem resultado confiável é **incerta**: não é repetida automaticamente nem impede o processamento dos demais contatos elegíveis.

Falhas comprovadamente anteriores à submissão e recuperáveis têm tentativas limitadas com espera progressiva. O aplicativo não procura contatos enviando mensagens de teste nem contorna restrições do WhatsApp.

## Dados, atualização e recuperação

- Perfil independente: `%APPDATA%\Automação Comunidade`.
- Banco SQLite: `automacao-comunidade.sqlite`. Sessão própria: subpasta `credentials`. O aplicativo não abre pastas de credenciais do Kenned Code Disparos.
- Em **Configurações → Criar backup**, salve um arquivo `.sqlite`. Ele inclui cadastros, modelos, campanhas, preferências e o controle operacional contra convites repetidos. A sessão protegida não é incluída.
- Para atualizar, faça backup, encerre pelo menu da bandeja e execute o novo instalador na mesma pasta exclusiva. Desinstalar preserva o perfil e os dados.
- Para recuperar, use **Restaurar backup**, digite `RESTAURAR` e selecione o arquivo. O banco é validado e uma cópia anterior à restauração fica em `backups`. As execuções restauradas ficam pausadas. Provas de envio e restrições posteriores ao backup são preservadas conservadoramente para evitar reenvios indevidos.
- Para voltar de uma atualização incompatível, encerre o aplicativo, preserve uma cópia integral do perfil atual e reinstale o instalador anterior compatível. Restaure o backup criado antes de atualizar. Não apague nem substitua manualmente o controle de convites.
- Ao restaurar em outro perfil do Windows, conecte novamente o WhatsApp. Credenciais protegidas pelo usuário/sistema não são transferidas em backups comuns.

O computador precisa estar ligado, sem suspensão, com internet e com o aplicativo em execução. Fechar a janela pode mantê-lo na bandeja, conforme a preferência. Use **Encerrar aplicativo** para finalizar. A opção **Iniciar com o Windows** é configurável.

## Integração e limitações verificadas

O aplicativo usa **Baileys 7.0.0-rc14**, biblioteca **não oficial**, por dispositivos conectados. A API da biblioteca disponibiliza consulta de grupos participantes, metadados/participantes e envio privado. WhatsApp pode modificar essas interfaces ou restringir a sessão.

- Nomes e telefones dependem do que a sessão disponibiliza. Um LID não é convertido em telefone; só se utiliza uma associação PN/LID confiável fornecida pela integração. Identidades ambíguas são bloqueadas.
- O grupo é salvo pelo ID real; mudança do nome não troca o vínculo.
- A consulta não garante acesso a todos os membros de uma comunidade ou a subgrupos que a conta não acessa.
- O histórico desta aplicação registra seus próprios convites; não representa o histórico completo do WhatsApp. Recibos e reconciliação dependem dos eventos disponíveis, inclusive depois de reiniciar.
- A sessão é criptografada via `safeStorage` do Electron, que usa DPAPI no Windows. O modo real recusa armazenamento inseguro em texto simples.
- A simulação é isolada, aparece com **SIMULAÇÃO — DADOS FICTÍCIOS**, só é carregada por ação explícita e não possui transporte para contatos reais.

Fontes do projeto da integração consultadas em 15/10/2026: [Baileys](https://github.com/WhiskeySockets/Baileys), [API de grupos](https://github.com/WhiskeySockets/Baileys/blob/master/src/Socket/groups.ts) e [metadados de grupos e participantes](https://github.com/WhiskeySockets/Baileys/blob/master/src/Types/GroupMetadata.ts).

## Código-fonte e verificações

Arquitetura: Electron com interface isolada, processo principal para integração com Windows e um worker para banco, integração e fila. SQLite transacional preserva reservas por destinatário e provas operacionais; consultas são paginadas. Uma única instância adquire o bloqueio antes de abrir o banco.

No ambiente de desenvolvimento, utilize Node.js 24 ou superior, `npm ci`, `npm test`, `npm run check` e `npm start`. `npm run dist:win` gera o instalador. O uso diário do instalador não exige terminal ou ambiente de desenvolvimento.

Consulte [VALIDACAO.md](docs/VALIDACAO.md) para resultados e pendências. Testes com transporte controlado ou simulado **não comprovam recebimento em um celular**.
