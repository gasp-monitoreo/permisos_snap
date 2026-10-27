from django.contrib.auth import views as auth_views
from django.urls import path
from tramites.api import api
from tramites import portal, views
from tramites.usuarios import LoginForm

urlpatterns = [
    path('login/', auth_views.LoginView.as_view(template_name='login.html', authentication_form=LoginForm,
                                                redirect_authenticated_user=True), name='login'),
    path('salud', views.salud, name='salud'),
    path('manual/', views.manual, name='manual'),
    path('manual/pdf', views.manual_pdf, name='manual-pdf'),
    path('manual/img/<str:archivo>', views.manual_img_admin, name='manual-img-admin'),
    path('logout/', auth_views.LogoutView.as_view(), name='logout'),
    path('cambiar-clave/', views.cambiar_clave, name='cambiar-clave'),
    path('', views.index, name='index'),
    path('api/', api.urls),
    path('portal/ingresar', portal.IngresoPortal.as_view(), name='portal-ingresar'),
    path('portal/', portal.portal, name='portal'),
    path('portal/api/registros', portal.api_registros, name='portal-registros'),
    path('portal/api/registros/crear', portal.api_crear, name='portal-crear'),
    path('portal/api/registros/<int:registro_id>', portal.api_editar, name='portal-editar'),
    path('portal/api/registros/<int:registro_id>/borrar', portal.api_borrar, name='portal-borrar'),
    path('portal/api/importar', portal.api_importar, name='portal-importar'),
    path('portal/api/descargar', portal.api_descargar, name='portal-descargar'),
    path('portal/api/permiso', portal.api_permiso, name='portal-permiso'),
    path('portal/api/documento/<slug:clave>', portal.api_documento, name='portal-documento'),
    path('portal/api/n6', portal.api_n6_listar, name='portal-n6-listar'),
    path('portal/api/n6/subir', portal.api_n6_subir, name='portal-n6-subir'),
    path('portal/api/n6/<int:archivo_id>/borrar', portal.api_n6_borrar, name='portal-n6-borrar'),
    path('investigaciones/', views.serve_investigacion, name='inv-root'),
    path('investigaciones/<path:filepath>', views.serve_investigacion, name='inv-file'),
    path('fotos/<str:archivo>', views.serve_foto, name='foto'),
    path('login/fotos.json', views.login_fotos, name='login-fotos'),
    path('auth/gmail/start', views.gmail_auth_start, name='gmail-start'),
    path('auth/gmail/callback', views.gmail_auth_callback, name='gmail-callback'),
]
