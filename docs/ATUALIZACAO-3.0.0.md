# Instalação, atualização e recuperação — Kenned Code Disparos 3.0.0

## Instalar ou atualizar

1. No Windows 10/11 x64, encerre o aplicativo pelo ícone da bandeja. Fechar apenas a janela pode deixar a fila funcionando.
2. Antes de atualizar, copie a pasta `%APPDATA%\Mega Disparos` inteira para um local privado. Esse nome legado permanece para preservar seus dados e credenciais. Não publique essa cópia.
3. Execute `Kenned-Code-Disparos-Setup-3.0.0-x64.exe`. Mantenha a pasta dedicada de instalação anterior. O runtime está incluído; não precisa de terminal ou Node.js.
4. Abra pelo atalho **Kenned Code Disparos**. O primeiro acesso permite cadastrar o dono; atualização conserva usuários existentes. A migração automática cria, antes de alterar o esquema, `backups\antes-migracao-v8-*.sqlite` dentro do perfil e mantém campanhas, mídias, configurações e identificadores.
5. Nas Configurações, confirme o modo real, cadastre somente administradores/destinatários autorizados e conecte pelo QR em **Aparelhos conectados**. Sincronize os grupos reais. O banner “SIMULAÇÃO — DADOS FICTÍCIOS” identifica testes sem envio real; as bases não se misturam.
6. Classifique os públicos de contatos e grupos antes de ativar listas comerciais. Confira a prévia; campanhas e propostas novas permanecem desativadas.

Instalador sem assinatura digital: o Windows pode informar editor desconhecido. Não foram verificados instalação física, notificações e áudio em Windows neste ambiente. O computador e aplicativo precisam estar ativos, com internet e sem suspensão. A integração Baileys é não oficial e depende do protocolo/condições da conta.

## Backup após a atualização

Em **Configurações → Backup e armazenamento → Recuperação completa do banco**, escolha onde guardar o `.sqlite` e seu manifesto `.json`. A função verifica a integridade e grava SHA256. É um backup consistente do banco completo, incluindo campanhas, configurações locais, usuários/hashes, estoque, vendas e livro de pagamentos de ambos os modos. Guarde-o em local privado com acesso restrito.

O backup não contém os arquivos de sessão/credenciais do WhatsApp, nem os arquivos de mídia. Preserve separadamente a pasta `media` do perfil; uma cópia privada do perfil inteiro, feita com o app encerrado, permite recuperação mais completa. O backup portátil tradicional de campanhas não contém vendas/caixa e não substitui esse backup financeiro.

## Recuperar a versão 3.0

1. Encerre o aplicativo, inclusive na bandeja. Faça outra cópia do perfil atual antes de substituir arquivos.
2. No perfil `%APPDATA%\Mega Disparos`, guarde o banco atual `mega.sqlite` e, se existirem, seus arquivos `mega.sqlite-wal` e `mega.sqlite-shm` em outra pasta. Não misture os arquivos de WAL do banco antigo com o restaurado.
3. Copie o backup escolhido para esse perfil e nomeie a cópia `mega.sqlite`. Preserve ou restaure a pasta `media` correspondente. Não altere os arquivos da sessão do WhatsApp.
4. Reabra a versão 3.0 e confira estoque, caixa, campanhas e usuários antes de retomar automações. Envios cujo resultado era incerto continuam exigindo revisão. Um backup antigo não sabe sobre vendas realizadas depois da sua criação: concilie essas operações antes de usar o sistema novamente.

## Voltar para a versão anterior

Uma versão antiga não pode abrir o esquema 8. Para voltar à 2.3, use a cópia **anterior à atualização** do perfil ou `antes-migracao-v8-*.sqlite`; siga a restauração com o app encerrado e reinstale o instalador 2.3 na mesma pasta. Preserve mídias e credenciais. Estoque e movimentos criados na 3.0 não existem na 2.3: mantenha uma cópia do banco 3.0 e do perfil para não perder o histórico novo. Não reabra campanhas automaticamente nem repita envios sem conferir os registros.
