# Correção da abertura do banco — 2.3.3

A mensagem “Este banco pertence a uma versão mais recente” foi reproduzida exatamente ao abrir, com a 2.3.2, um banco do esquema 8 gerado pelo código existente da linha 3.x. A linha 2.3 mantinha o esquema 7 e recusava qualquer número superior antes de criar a cópia de recuperação.

As 41 tabelas comuns, as constraints e os gatilhos de auditoria do esquema 8 conhecido coincidem com o núcleo 7. A linha mais recente acrescentou tabelas e recursos separados. Isso permite uma abertura compatível sem diminuir `PRAGMA user_version`, apagar dados ou importar módulos comerciais/financeiros.

## Correção

- A 2.3.3 continua baseada na linha 2.3. Bancos novos usam esquema 7; o esquema 8 conhecido é aceito somente após conferir DDL, colunas, unicidade, gatilhos e integridade. Versões futuras desconhecidas ou estruturas alteradas continuam recusadas com mensagem específica, sem apagar o banco.
- Antes de qualquer alteração de compatibilidade, o aplicativo cria um snapshot SQLite consistente, incluindo o WAL, com `VACUUM INTO`, e confere sua integridade. Se a cópia falhar, a abertura é bloqueada antes de alterar os cadastros.
- O banco 8 continua marcado como 8. Tabelas e registros adicionais permanecem no arquivo e na cópia de recuperação; não há menu nem serviço financeiro nesta versão.
- Na primeira abertura compatível, as automações dos modos real e simulado ficam interrompidas e campanhas em execução ficam pausadas. A aprovação e o estado de parada são gravados juntos. Não se repete essa pausa de compatibilidade em cada reinício.
- Confirmados e incertos conservam seu controle operacional. A inicialização normal cancela filas antigas ainda não submetidas e pede revisão para operações cujo resultado não pôde ser confirmado.
- Campanhas e modelos com vínculos ou regras estruturais exclusivos da linha comercial são preservados para consulta, mas não podem executar nem perder esses vínculos silenciosamente ao editar/aplicar. Crie uma campanha comum com conteúdo revisado. A detecção usa campos estruturais, nunca nomes ou palavras no anúncio.
- Configurações mostra a compatibilidade e o caminho do backup para usuários com acesso autorizado. O evento também é registrado em auditoria. Usuários, permissões, responsáveis e arquivos de sessão não são recriados.

## Instalar e recuperar

Encerre o aplicativo pela bandeja. Copie toda a pasta `%APPDATA%\Mega Disparos` para um local privado, incluindo banco, mídias e sessões. Execute o instalador 2.3.3 sobre a instalação existente. Abra, entre com seu usuário anterior e confira Configurações → Backup e armazenamento. Revise campanhas e destinos antes de retomar os envios.

A cópia automática fica em `backups/antes-atualizacao-2.3.3-...sqlite` dentro do perfil e contém o banco anterior à aprovação. Guarde também a pasta completa: o snapshot do banco não inclui os arquivos de mídia nem a identidade protegida fora do perfil.

Para recuperação, encerre o aplicativo e preserve primeiro o perfil atual. Restaure a cópia completa privada ou o banco consistente correspondente, sem deixar arquivos WAL/SHM de outra cópia ao lado. Utilize um aplicativo compatível com o esquema recuperado. A 2.3.2 continuará recusando um banco 8; voltar apenas o executável não resolve esse conflito. Não diminua o número do esquema manualmente e não apague o banco para contornar o erro.

O licenciamento usa o mesmo serviço, chave pública e âncoras protegidas. Atualizar não reinicia o teste nem altera o prazo contratado. Não apague `%LOCALAPPDATA%\KennedCodeDisparos-Licensing` nem as âncoras do registro.

## Evidências e limites

Os testes usam bancos isolados do esquema conhecido, código real de persistência e criptografia/login reais. Incluem preservação de hashes de senha, tokens de recuperação, contatos, ofertas, grupos separados por modo, modelos, arquivos, lembretes, responsáveis, envios confirmados/incertos, dados adicionais, backup recuperável, reinício, recusa de esquema futuro, proteção contra unicidade ausente/gatilho desconhecido e falhas de gravação.

A interface Electron foi executada com banco 8 e licença validada pelo serviço HTTPS publicado. A abertura do banco real do usuário ainda precisa ser confirmada após instalar: o arquivo não foi disponibilizado nesta execução. O ambiente é Linux; execução do ASAR e verificação do .exe não equivalem a instalar em Windows físico. Não houve envio WhatsApp real durante esses testes.
