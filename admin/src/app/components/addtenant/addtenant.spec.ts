import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Addtenant } from './addtenant';

describe('Addtenant', () => {
  let component: Addtenant;
  let fixture: ComponentFixture<Addtenant>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Addtenant],
    }).compileComponents();

    fixture = TestBed.createComponent(Addtenant);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
